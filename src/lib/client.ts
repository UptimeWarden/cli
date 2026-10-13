/**
 * Minimal fetch wrapper around the UptimeWarden REST API.
 *
 * Keeps three concerns out of every command:
 *   1. Auth: every call gets `Authorization: Bearer <token>`.
 *   2. Provenance: every write tags `X-UW-Source: cli` so server-side
 *      audit logging can attribute changes correctly.
 *   3. Error normalization: non-2xx becomes `ApiError` with the parsed
 *      body so commands can format friendly messages.
 *
 * No third-party HTTP lib — Node 20+ ships `fetch` natively, which keeps
 * the install footprint of `@uptimewarden/cli` tiny.
 */
import { resolveConfig } from "./config.js";
import { USER_AGENT } from "../version.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    public url: string,
  ) {
    super(`API ${status} from ${url}: ${JSON.stringify(body)}`);
    this.name = "ApiError";
  }
}

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  /** Override the global fetch — primarily for tests. */
  fetchImpl?: typeof fetch;
}

export function createClient(opts: ClientOptions = {}) {
  const cfg = resolveConfig();
  const baseUrl = (opts.baseUrl ?? cfg.baseUrl).replace(/\/$/, "");
  const token = opts.token ?? cfg.apiToken;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      "X-UW-Source": "cli",
      ...extraHeaders,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Heartbeat ping endpoints return 204 / plain text. Don't try to JSON
    // parse them — return null for the body and let the caller treat the
    // resolved promise as success.
    const ct = res.headers.get("content-type") ?? "";
    const parsed: unknown = ct.includes("application/json") ? await res.json().catch(() => null) : null;

    if (!res.ok) throw new ApiError(res.status, parsed, url);
    return parsed as T;
  }

  return {
    baseUrl,
    hasToken: Boolean(token),
    get: <T = unknown>(p: string) => request<T>("GET", p),
    post: <T = unknown>(p: string, body?: unknown, headers?: Record<string, string>) =>
      request<T>("POST", p, body, headers),
    patch: <T = unknown>(p: string, body?: unknown) => request<T>("PATCH", p, body),
    put: <T = unknown>(p: string, body?: unknown) => request<T>("PUT", p, body),
    delete: <T = unknown>(p: string) => request<T>("DELETE", p),
    /**
     * Heartbeat signal. Public endpoint — the token is the credential, no
     * auth header. kind "ping" reports success, "fail" a failure.
     */
    heartbeatPing: async (token: string, payload?: Record<string, unknown>, kind: "ping" | "fail" = "ping") => {
      const url = `${baseUrl}/api/heartbeat/${encodeURIComponent(token)}/${kind}`;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-UW-Source": "cli",
        },
        body: JSON.stringify(payload ?? {}),
      });
      if (!res.ok) {
        const ct = res.headers.get("content-type") ?? "";
        const parsed: unknown = ct.includes("application/json") ? await res.json().catch(() => null) : null;
        throw new ApiError(res.status, parsed, url);
      }
      return { status: res.status, url };
    },
  };
}

export type Client = ReturnType<typeof createClient>;
