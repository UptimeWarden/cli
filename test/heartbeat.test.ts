/**
 * heartbeat.test.ts — verifies POST hits the right URL, headers, and body.
 *
 * No real network: we inject a stub `fetch` and assert on what the
 * command would have sent. Anything that breaks the heartbeat URL
 * pattern breaks every customer using the GitHub Action, so this test
 * is the load-bearing safety net for that integration.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Command } from "commander";
import { registerHeartbeatCommand, runHeartbeat } from "../src/commands/heartbeat.js";

interface RecordedCall {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("uw heartbeat", () => {
  beforeEach(() => {
    delete process.env.UW_API_TOKEN;
    delete process.env.UW_API_URL;
    process.env.UW_CONFIG_DIR = "/tmp/uw-cli-test-" + Date.now();
  });

  it("POSTs to /api/heartbeat/:token/ping with default base URL", async () => {
    const { calls, fetchImpl } = makeFetch();
    await runHeartbeat("abc123", { fetchImpl, baseUrl: "https://api.example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/api/heartbeat/abc123/ping");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers["X-UW-Source"]).toBe("cli");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("URL-encodes tricky tokens", async () => {
    const { calls, fetchImpl } = makeFetch();
    await runHeartbeat("a/b c", { fetchImpl, baseUrl: "https://api.example.com" });
    expect(calls[0].url).toBe("https://api.example.com/api/heartbeat/a%2Fb%20c/ping");
  });

  it("attaches state + message to the payload when provided", async () => {
    const { calls, fetchImpl } = makeFetch();
    await runHeartbeat("tok", { fetchImpl, baseUrl: "https://api.example.com", state: "success", message: "deploy 17 ok" });
    expect(calls[0].url).toBe("https://api.example.com/api/heartbeat/tok/ping");
    expect(calls[0].body).toEqual({ message: "deploy 17 ok" });
  });

  it("--state failure POSTs to /fail with the message", async () => {
    const { calls, fetchImpl } = makeFetch();
    await runHeartbeat("tok", { fetchImpl, baseUrl: "https://api.example.com", state: "failure", message: "pg_dump exited 1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.example.com/api/heartbeat/tok/fail");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ message: "pg_dump exited 1" });
  });

  it("sends a long message as is (the API keeps the first 500 characters)", async () => {
    const { calls, fetchImpl } = makeFetch();
    await runHeartbeat("tok", { fetchImpl, baseUrl: "https://api.example.com", state: "failure", message: "x".repeat(600) });
    expect((calls[0].body as { message: string }).message).toHaveLength(600);
  });

  it("rejects unknown states without sending anything", async () => {
    const { calls, fetchImpl } = makeFetch();
    await expect(
      runHeartbeat("tok", { fetchImpl, baseUrl: "https://api.example.com", state: "degraded" as "success" }),
    ).rejects.toThrow(/must be "success" or "failure"/);
    expect(calls).toHaveLength(0);
  });

  it("uw heartbeat --state failure --message (commander) calls /fail and exits 0", async () => {
    const { calls, fetchImpl } = makeFetch();
    vi.stubGlobal("fetch", fetchImpl);
    let out = "";
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    });
    try {
      process.exitCode = undefined;
      const program = new Command();
      program.exitOverride();
      registerHeartbeatCommand(program);
      await program.parseAsync([
        "node", "uw", "heartbeat", "tok", "--state", "failure", "--message", "boom", "--base-url", "https://api.example.com",
      ]);
      expect(process.exitCode).toBeUndefined();
      expect(calls.map((c) => c.url)).toEqual(["https://api.example.com/api/heartbeat/tok/fail"]);
      expect(calls[0].body).toEqual({ message: "boom" });
      expect(out).toMatch(/\/fail/);
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
      process.exitCode = undefined;
    }
  });

  it("rejects empty token", async () => {
    const { fetchImpl } = makeFetch();
    await expect(runHeartbeat("", { fetchImpl })).rejects.toThrow(/required/);
  });

  it("surfaces non-2xx as ApiError", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    await expect(runHeartbeat("missing", { fetchImpl, baseUrl: "https://api.example.com" })).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
    });
  });
});
