/**
 * Developer contract for @uptimewarden/cli.
 *
 * API tokens (`uptw_`) authenticate only on `/api/v1/*`. Apply talks to
 * that surface and unwraps `{success,data}` list envelopes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asLiveMonitors, runApply, type LiveMonitor } from "../src/commands/apply.js";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function makeFetch(
  live: unknown,
  onWrite?: (call: RecordedCall) => unknown,
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, headers, body });

    if (method === "GET") {
      return new Response(JSON.stringify(live), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const responseBody = onWrite?.({ url, method, headers, body }) ?? { publicId: "new_pub_id" };
    return new Response(JSON.stringify(responseBody), {
      status: method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uw-cli-contract-"));
  process.env.UW_CONFIG_DIR = tmp;
  delete process.env.UW_API_TOKEN;
});

describe("asLiveMonitors envelope unwrap", () => {
  it("accepts a bare array (dashboard GET /api/monitors)", () => {
    const live: LiveMonitor[] = [{ publicId: "p1", externalId: "a", name: "A" }];
    expect(asLiveMonitors(live)).toEqual(live);
  });

  it("unwraps v1 {success,data,pagination} so apply can consume token-auth list", () => {
    expect(
      asLiveMonitors({
        success: true,
        data: [{ publicId: "p1", externalId: "a", name: "A" }],
        pagination: { page: 1, limit: 20, total: 1 },
      }),
    ).toEqual([{ publicId: "p1", externalId: "a", name: "A" }]);
  });

  it("returns [] for unexpected shapes instead of throwing", () => {
    expect(asLiveMonitors(null)).toEqual([]);
    expect(asLiveMonitors({ success: true })).toEqual([]);
  });
});

describe("CLI apply — token-auth v1 surface", () => {
  it("lists via GET /api/v1/monitors?managedBySource=cli with the maximum page size", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(cfgFile, JSON.stringify({ monitors: [] }));
    const { calls, fetchImpl } = makeFetch({ success: true, data: [] });
    await runApply({ file: cfgFile, fetchImpl, baseUrl: "https://uw.example.com" });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://uw.example.com/api/v1/monitors?managedBySource=cli&limit=100&page=1");
  });

  it("POSTs create with externalId + managedBySource=cli", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        monitors: [{ externalId: "api-prod", name: "API Prod", type: "http", url: "https://api.example.com" }],
      }),
    );
    const { calls, fetchImpl } = makeFetch({ success: true, data: [] });
    await runApply({ file: cfgFile, yes: true, fetchImpl, baseUrl: "https://uw.example.com" });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://uw.example.com/api/v1/monitors");
    expect(post?.body).toMatchObject({
      name: "API Prod",
      type: "http",
      url: "https://api.example.com",
      externalId: "api-prod",
      managedBySource: "cli",
    });
  });

  it("can consume a v1 list envelope without treating every monitor as create", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        monitors: [{ externalId: "api-prod", name: "API Prod", interval: 60 }],
      }),
    );
    const { fetchImpl } = makeFetch({
      success: true,
      data: [
        {
          publicId: "01HWTEST",
          externalId: "api-prod",
          name: "API Prod",
          type: "http",
          url: "https://x.com",
          interval: 60,
        },
      ],
    });
    const result = await runApply({ file: cfgFile, fetchImpl, baseUrl: "https://uw.example.com" });
    expect(result.diff.toCreate).toHaveLength(0);
    expect(result.diff.toUpdate).toHaveLength(0);
    expect(result.diff.toDelete).toHaveLength(0);
  });

  it("PATCHes via /api/v1/monitors/{publicId}", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        monitors: [{ externalId: "api-prod", name: "API Prod v2", type: "http", url: "https://api.example.com" }],
      }),
    );
    const { calls, fetchImpl } = makeFetch({
      success: true,
      data: [
        {
          publicId: "01HWTEST0000000000000001",
          externalId: "api-prod",
          name: "API Prod",
          type: "http",
          url: "https://api.example.com",
        },
      ],
    });
    await runApply({ file: cfgFile, yes: true, fetchImpl, baseUrl: "https://uw.example.com" });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://uw.example.com/api/v1/monitors/01HWTEST0000000000000001");
  });
});
