/**
 * apply.pagination-replace.test.ts
 *
 *  - GET /api/v1/monitors is paginated (limit ≤ 100, default 20). Apply must
 *    read every page, or monitors past the first page look missing and get
 *    created a second time.
 *  - The API cannot change a monitor's type in place. A type change is a
 *    replacement (delete + create) with --allow-delete, otherwise blocked.
 *  - --json prints a machine-readable plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  computeDiff,
  planToJson,
  registerApplyCommand,
  runApply,
  type LiveMonitor,
} from "../src/commands/apply.js";

interface RecordedCall {
  url: string;
  method: string;
  body?: unknown;
}

/** A v1-shaped server: filters nothing, paginates like parseListPagination. */
function paginatedFetch(
  live: LiveMonitor[],
  onWrite?: (call: RecordedCall) => unknown,
): { calls: RecordedCall[]; fetchImpl: typeof fetch } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: url.toString(), method, body });
    const detail = url.pathname.match(/^\/api\/v1\/monitors\/([^/]+)$/);
    if (method === "GET" && detail) {
      const m = live.find((x) => x.publicId === decodeURIComponent(detail[1]));
      return new Response(JSON.stringify(m ? { success: true, data: m } : { success: false }), {
        status: m ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "GET") {
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const limit = Math.min(100, Number(url.searchParams.get("limit")) || 20);
      const start = (page - 1) * limit;
      const data = live.slice(start, start + limit);
      const total = live.length;
      return new Response(
        JSON.stringify({
          success: true,
          data,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasNextPage: start + limit < total,
            hasPrevPage: page > 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    const responseBody = onWrite?.({ url: url.toString(), method, body }) ?? {
      success: true,
      data: { publicId: "new_pub_id", timeout: 30 },
    };
    return new Response(JSON.stringify(responseBody), {
      status: method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const managed = (n: number): LiveMonitor[] =>
  Array.from({ length: n }, (_, i) => ({
    publicId: `pub_${i}`,
    externalId: `mon-${i}`,
    name: `Monitor ${i}`,
    type: "http",
    url: `https://example.com/${i}`,
  }));

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uw-cli-page-"));
  process.env.UW_CONFIG_DIR = tmp;
  delete process.env.UW_API_TOKEN;
});

function writeCfg(monitors: unknown[]): string {
  const file = join(tmp, "m.json");
  writeFileSync(file, JSON.stringify({ monitors }));
  return file;
}

describe("apply reads every page of managed monitors", () => {
  it("250 managed monitors, all declared: no creates, three pages read", async () => {
    const live = managed(250);
    const file = writeCfg(live.map(({ externalId, name, type, url }) => ({ externalId, name, type, url })));
    const { calls, fetchImpl } = paginatedFetch(live);

    const result = await runApply({ file, yes: true, fetchImpl, baseUrl: "https://uw.example.com" });

    const gets = calls.filter((c) => c.method === "GET");
    expect(gets.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    for (const g of gets) {
      expect(new URL(g.url).searchParams.get("limit")).toBe("100");
      expect(new URL(g.url).searchParams.get("managedBySource")).toBe("cli");
    }
    expect(result.diff.toCreate).toHaveLength(0);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("monitors on later pages missing from the config are deletions, not ignored", async () => {
    const live = managed(120);
    const file = writeCfg([{ externalId: "mon-0", name: "Monitor 0", type: "http", url: "https://example.com/0" }]);
    const { fetchImpl } = paginatedFetch(live);
    const result = await runApply({ file, fetchImpl, baseUrl: "https://uw.example.com" });
    expect(result.diff.toDelete).toHaveLength(119);
  });

  it("stops after one request when the server returns a bare array", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(input.toString());
      return new Response(JSON.stringify(managed(3)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const file = writeCfg([]);
    const result = await runApply({ file, fetchImpl, baseUrl: "https://uw.example.com" });
    expect(calls).toHaveLength(1);
    expect(result.diff.toDelete).toHaveLength(3);
  });
});

describe("type changes", () => {
  const live: LiveMonitor[] = [
    { publicId: "pub_db", externalId: "db", name: "DB", type: "http", url: "tcp://db:5432" },
  ];

  it("http → tcp is an in-place update (PATCH with type)", async () => {
    const file = writeCfg([{ externalId: "db", name: "DB", type: "tcp", url: "tcp://db:5432" }]);
    const { calls, fetchImpl } = paginatedFetch(live);
    const result = await runApply({ file, yes: true, fetchImpl, baseUrl: "https://uw.example.com", log: () => {} });
    expect(result.diff.toReplace).toHaveLength(0);
    expect(result.updated).toBe(1);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => c.method)).toEqual(["PATCH"]);
    expect(writes[0].body).toEqual({ type: "tcp" });
  });

  const toHeartbeat = [{ externalId: "db", name: "DB", type: "heartbeat", heartbeatGraceSeconds: 120 }];

  it("http → heartbeat is a replacement", () => {
    const diff = computeDiff({ monitors: toHeartbeat }, live);
    expect(diff.toUpdate).toHaveLength(0);
    expect(diff.toReplace).toHaveLength(1);
    expect(diff.toReplace[0].changedFields).toContain("type");
  });

  it("without --allow-delete: nothing is written and the change is reported blocked", async () => {
    const file = writeCfg(toHeartbeat);
    const { calls, fetchImpl } = paginatedFetch(live);
    const lines: string[] = [];
    const result = await runApply({
      file,
      yes: true,
      fetchImpl,
      baseUrl: "https://uw.example.com",
      log: (l) => lines.push(l),
    });
    expect(result.blocked).toBe(1);
    expect(result.replaced).toBe(0);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    expect(lines.join("\n")).toMatch(/cannot change a monitor to or from heartbeat/);
    expect(lines.join("\n")).toMatch(/--allow-delete/);
  });

  it("with --allow-delete: DELETE the old monitor, then POST the heartbeat (no url)", async () => {
    const file = writeCfg(toHeartbeat);
    const { calls, fetchImpl } = paginatedFetch(live);
    const result = await runApply({
      file,
      yes: true,
      allowDelete: true,
      fetchImpl,
      baseUrl: "https://uw.example.com",
      log: () => {},
    });
    expect(result.replaced).toBe(1);
    expect(result.blocked).toBe(0);
    const writes = calls.filter((c) => c.method !== "GET");
    expect(writes.map((c) => c.method)).toEqual(["DELETE", "POST"]);
    expect(writes[0].url).toContain("/api/v1/monitors/pub_db");
    expect(writes[1].body).toEqual({
      externalId: "db", name: "DB", type: "heartbeat", heartbeatGraceSeconds: 120, managedBySource: "cli",
    });
  });

  it("the plan JSON marks the replacement as blocked without --allow-delete", () => {
    const diff = computeDiff({ monitors: toHeartbeat }, live);
    const plan = planToJson(diff, false);
    expect(plan.hasDrift).toBe(true);
    expect(plan.replace).toEqual([
      {
        externalId: "db",
        publicId: "pub_db",
        fromType: "http",
        toType: "heartbeat",
        changedFields: ["type", "heartbeatGraceSeconds"],
        blocked: true,
      },
    ]);
  });
});

describe("uw apply exit codes and --json (commander)", () => {
  let out: string;
  let err: string;
  beforeEach(() => {
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err += chunk.toString();
      return true;
    });
    process.exitCode = undefined;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  async function run(args: string[], live: LiveMonitor[]) {
    const { fetchImpl } = paginatedFetch(live);
    vi.stubGlobal("fetch", fetchImpl);
    const program = new Command();
    program.exitOverride();
    registerApplyCommand(program);
    await program.parseAsync(["node", "uw", "apply", ...args]);
  }

  it("--json --diff-only prints a parseable plan and exits 2 on drift", async () => {
    const file = writeCfg([{ externalId: "new", name: "New", type: "http", url: "https://n" }]);
    await run(["-f", file, "--json", "--diff-only", "--base-url", "https://uw.example.com"], []);
    const plan = JSON.parse(out);
    expect(plan).toMatchObject({ applied: false, hasDrift: true, create: [{ externalId: "new" }] });
    expect(process.exitCode).toBe(2);
  });

  it("--json without drift: hasDrift false, exit 0", async () => {
    const live = managed(1);
    const file = writeCfg([{ externalId: "mon-0", name: "Monitor 0" }]);
    await run(["-f", file, "--json", "--diff-only", "--base-url", "https://uw.example.com"], live);
    expect(JSON.parse(out)).toMatchObject({ hasDrift: false, create: [], update: [], replace: [], delete: [] });
    expect(process.exitCode).toBeUndefined();
  });

  it("--yes with a blocked type change exits 1", async () => {
    const live: LiveMonitor[] = [{ publicId: "p", externalId: "x", name: "X", type: "http" }];
    const file = writeCfg([{ externalId: "x", name: "X", type: "heartbeat" }]);
    await run(["-f", file, "--yes", "--base-url", "https://uw.example.com"], live);
    expect(process.exitCode).toBe(1);
    expect(out).toMatch(/blocked/);
  });

  it("--yes --json keeps stdout pure JSON (progress goes to stderr)", async () => {
    const file = writeCfg([{ externalId: "new", name: "New", type: "http", url: "https://n" }]);
    await run(["-f", file, "--yes", "--json", "--base-url", "https://uw.example.com"], []);
    expect(JSON.parse(out)).toMatchObject({ applied: true, created: 1, blocked: 0 });
    expect(err).toMatch(/creating/);
  });
});
