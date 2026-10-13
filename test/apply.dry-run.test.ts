/**
 * apply.dry-run.test.ts — exercises the `uw apply` diff path against a
 * mock server (stub fetch). Verifies that:
 *   1. We call /api/v1/monitors?managedBySource=cli to read live state.
 *   2. computeDiff classifies create / update / delete correctly.
 *   3. apply without --yes NEVER writes (no PUT/POST/DELETE issued).
 *   4. Missing config file fails fast with a useful error.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDiff, runApply, loadConfig, type LiveMonitor } from "../src/commands/apply.js";

interface RecordedCall { url: string; method?: string }

function makeFetch(liveMonitors: LiveMonitor[]): {
  calls: RecordedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: input.toString(), method: init?.method ?? "GET" });
    return new Response(JSON.stringify(liveMonitors), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uw-cli-apply-"));
  process.env.UW_CONFIG_DIR = tmp;
  delete process.env.UW_API_TOKEN;
});

const live = (partial: Partial<LiveMonitor> & { externalId: string; name: string }): LiveMonitor =>
  ({ publicId: "pub_" + partial.externalId, type: "http", url: "https://x.com", interval: 300, ...partial });

describe("computeDiff (pure)", () => {
  it("classifies missing → create, name change → update, extra → delete", () => {
    const diff = computeDiff(
      { monitors: [
        { externalId: "homepage", name: "Homepage v2" },
        { externalId: "checkout", name: "Checkout flow" },
        { externalId: "newone", name: "New monitor" },
      ] },
      [
        live({ externalId: "homepage", name: "Homepage v1" }),
        live({ externalId: "checkout", name: "Checkout flow" }),
        live({ externalId: "old", name: "Old monitor" }),
      ],
    );
    expect(diff.toCreate.map((m) => m.externalId)).toEqual(["newone"]);
    expect(diff.toUpdate.map((u) => u.desired.externalId)).toEqual(["homepage"]);
    expect(diff.toUpdate[0].changedFields).toContain("name");
    expect(diff.toDelete.map((m) => m.externalId)).toEqual(["old"]);
  });

  it("detects field-level drift beyond name", () => {
    const diff = computeDiff(
      { monitors: [{ externalId: "api", name: "API", interval: 60 }] },
      [live({ externalId: "api", name: "API", interval: 300 })],
    );
    expect(diff.toUpdate).toHaveLength(1);
    expect(diff.toUpdate[0].changedFields).toEqual(["interval"]);
  });

  it("no diff when all fields match", () => {
    const diff = computeDiff(
      { monitors: [{ externalId: "api", name: "API", interval: 60, url: "https://x.com" }] },
      [live({ externalId: "api", name: "API", interval: 60, url: "https://x.com" })],
    );
    expect(diff.toCreate).toHaveLength(0);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toDelete).toHaveLength(0);
  });

  it("empty input produces empty diff", () => {
    const empty = computeDiff({ monitors: [] }, []);
    expect(empty.toCreate).toHaveLength(0);
    expect(empty.toUpdate).toHaveLength(0);
    expect(empty.toDelete).toHaveLength(0);
  });
});

describe("uw apply --file", () => {
  it("without --yes: reads live state, prints diff, never writes", async () => {
    const cfgFile = join(tmp, "monitors.uw.json");
    writeFileSync(cfgFile, JSON.stringify({ monitors: [{ externalId: "homepage-prod", name: "Homepage prod" }] }));
    const { calls, fetchImpl } = makeFetch([]);
    const { diff, applied } = await runApply({ file: cfgFile, fetchImpl, baseUrl: "https://api.example.com" });
    expect(diff.toCreate).toHaveLength(1);
    expect(applied).toBe(false);
    const writeCalls = calls.filter((c) => ["POST", "PATCH", "PUT", "DELETE"].includes(c.method ?? ""));
    expect(writeCalls).toHaveLength(0);
    expect(calls[0].url).toContain("/api/v1/monitors?managedBySource=cli");
  });

  it("loadConfig fails fast on missing file", () => {
    expect(() => loadConfig(join(tmp, "nope.json"))).toThrow(/not found/);
  });

  it("loadConfig rejects entries without externalId or name", () => {
    const cfgFile = join(tmp, "bad.json");
    writeFileSync(cfgFile, JSON.stringify({ monitors: [{ name: "no ext id" }] }));
    expect(() => loadConfig(cfgFile)).toThrow(/externalId/);
  });
});
