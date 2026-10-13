/**
 * apply.write.test.ts — exercises the real write path (--yes).
 *
 * Uses a stub fetch that intercepts POST / PATCH / DELETE calls and returns
 * plausible responses so runApply can complete without a real server.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApply, type LiveMonitor } from "../src/commands/apply.js";

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

function makeFetch(
  live: LiveMonitor[],
  onWrite?: (call: RecordedCall) => unknown,
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });

    // GET /api/v1/monitors — return live state
    if (method === "GET") {
      return new Response(JSON.stringify(live), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Write calls — delegate to onWrite or return a generic success
    const responseBody = onWrite?.({ url, method, body }) ?? { publicId: "new_pub_id" };
    return new Response(JSON.stringify(responseBody), {
      status: method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return { calls, fetchImpl };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uw-cli-write-"));
  process.env.UW_CONFIG_DIR = tmp;
  delete process.env.UW_API_TOKEN;
});

describe("uw apply --yes create", () => {
  it("POSTs new monitor with managedBySource=cli", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(cfgFile, JSON.stringify({
      monitors: [{ externalId: "api-prod", name: "API Prod", type: "http", url: "https://api.example.com/health", interval: 60 }],
    }));

    const { calls, fetchImpl } = makeFetch([]); // live = empty
    const result = await runApply({ file: cfgFile, yes: true, fetchImpl, baseUrl: "https://uw.example.com" });

    expect(result.applied).toBe(true);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);

    const postCall = calls.find((c) => c.method === "POST");
    expect(postCall).toBeDefined();
    expect(postCall!.body).toMatchObject({
      name: "API Prod",
      type: "http",
      url: "https://api.example.com/health",
      interval: 60,
      externalId: "api-prod",
      managedBySource: "cli",
    });
  });
});

describe("uw apply --yes update", () => {
  it("PATCHes only changed fields", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(cfgFile, JSON.stringify({
      monitors: [{ externalId: "api-prod", name: "API Prod", interval: 30 }],
    }));

    const live: LiveMonitor[] = [{
      publicId: "pub_01HWTEST",
      externalId: "api-prod",
      name: "API Prod",
      type: "http",
      url: "https://api.example.com",
      interval: 60, // changed
    }];
    const { calls, fetchImpl } = makeFetch(live);
    const result = await runApply({ file: cfgFile, yes: true, fetchImpl, baseUrl: "https://uw.example.com" });

    expect(result.applied).toBe(true);
    expect(result.updated).toBe(1);

    const patchCall = calls.find((c) => c.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(patchCall!.url).toContain("pub_01HWTEST");
    // Only interval was changed — name was not in the diff
    expect(patchCall!.body).toEqual({ interval: 30 });
  });
});

describe("uw apply --yes delete protection", () => {
  it("does NOT delete without --allow-delete", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(cfgFile, JSON.stringify({ monitors: [] })); // empty = nothing desired

    const live: LiveMonitor[] = [{ publicId: "pub_del", externalId: "old-mon", name: "Old" }];
    const { calls, fetchImpl } = makeFetch(live);
    const result = await runApply({ file: cfgFile, yes: true, allowDelete: false, fetchImpl, baseUrl: "https://uw.example.com" });

    expect(result.deleted).toBe(0);
    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });

  it("deletes when --allow-delete is set", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(cfgFile, JSON.stringify({ monitors: [] }));

    const live: LiveMonitor[] = [{ publicId: "pub_del", externalId: "old-mon", name: "Old" }];
    const { calls, fetchImpl } = makeFetch(live, () => null);
    const result = await runApply({ file: cfgFile, yes: true, allowDelete: true, fetchImpl, baseUrl: "https://uw.example.com" });

    expect(result.deleted).toBe(1);
    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].url).toContain("pub_del");
  });
});

describe("uw apply without --yes", () => {
  it("never writes even when drift exists", async () => {
    const cfgFile = join(tmp, "m.json");
    writeFileSync(cfgFile, JSON.stringify({
      monitors: [{ externalId: "a", name: "A" }, { externalId: "b", name: "B" }],
    }));
    const { calls, fetchImpl } = makeFetch([]);
    const result = await runApply({ file: cfgFile, yes: false, fetchImpl, baseUrl: "https://uw.example.com" });

    expect(result.applied).toBe(false);
    expect(result.created).toBe(0);
    const writeCalls = calls.filter((c) => ["POST", "PATCH", "DELETE"].includes(c.method));
    expect(writeCalls).toHaveLength(0);
  });
});
