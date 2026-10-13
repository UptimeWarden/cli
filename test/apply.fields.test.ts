/**
 * apply.fields.test.ts — the full /api/v1/monitors field set in apply:
 * config validation, nested-object and set diffs, the contract's clearing
 * values, detail reads, groups after create, heartbeat creates and name
 * resolution for escalation policies and webhooks.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeDiff, loadConfig, runApply, type LiveMonitor } from "../src/commands/apply.js";

const POLICY = "01HWPXSY000000000000000001";
const HOOK_A = "01HWHKWB000000000000000001";
const HOOK_B = "01HWHKWB000000000000000002";

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** v1-shaped stub: list (summary rows), detail, policies, webhooks, writes. */
function api(details: Array<Record<string, unknown>>, opts: { policies?: unknown[]; webhooks?: unknown[] } = {}) {
  const calls: Call[] = [];
  const summary = (m: Record<string, unknown>) => {
    const keep = ["publicId", "name", "type", "externalId", "url", "interval", "timeout", "isActive", "region",
      "hostname", "tags", "groups", "managedBySource"];
    return Object.fromEntries(Object.entries(m).filter(([k]) => keep.includes(k)));
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname === "/api/v1/monitors") {
      return json({ success: true, data: details.map(summary), pagination: { page: 1, hasNextPage: false } });
    }
    if (method === "GET" && url.pathname === "/api/v1/escalation-policies") {
      return json({ success: true, data: opts.policies ?? [] });
    }
    if (method === "GET" && url.pathname === "/api/v1/webhooks") {
      return json({ success: true, data: opts.webhooks ?? [] });
    }
    const m = url.pathname.match(/^\/api\/v1\/monitors\/(.+)$/);
    if (method === "GET" && m) {
      const found = details.find((d) => d.publicId === m[1]);
      return found ? json({ success: true, data: found }) : json({ success: false }, 404);
    }
    if (method === "POST") {
      return json({ success: true, data: { publicId: "01HWNEW0000000000000000001", ...body, timeout: body?.timeout ?? 30 } }, 201);
    }
    return json({ success: true, data: { publicId: m?.[1], ...body } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uw-cli-fields-"));
  process.env.UW_CONFIG_DIR = tmp;
  delete process.env.UW_API_TOKEN;
});

function cfg(monitors: unknown[]): string {
  const file = join(tmp, "m.json");
  writeFileSync(file, JSON.stringify({ monitors }));
  return file;
}

const run = (file: string, fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  runApply({ file, fetchImpl, baseUrl: "https://uw.example.com", log: () => {}, ...extra });

describe("config validation", () => {
  it("rejects an unknown field by name (the API would 400 on it)", () => {
    expect(() => loadConfig(cfg([{ externalId: "a", name: "A", url: "https://a", expected_status_codes: "200" }])))
      .toThrow(/a: unknown field "expected_status_codes"/);
  });

  it("rejects managedBySource (the CLI sets it)", () => {
    expect(() => loadConfig(cfg([{ externalId: "a", name: "A", managedBySource: "manual" }]))).toThrow(/managedBySource/);
  });

  it("rejects a url on a heartbeat monitor and an unknown type", () => {
    expect(() => loadConfig(cfg([{ externalId: "a", name: "A", type: "heartbeat", url: "https://a" }]))).toThrow(/remove url/);
    expect(() => loadConfig(cfg([{ externalId: "a", name: "A", type: "ftp" }]))).toThrow(/type must be one of/);
  });

  it("rejects a duplicate externalId", () => {
    expect(() => loadConfig(cfg([{ externalId: "a", name: "A" }, { externalId: "a", name: "B" }]))).toThrow(/declared twice/);
  });

  it("accepts every contract field", () => {
    const all = {
      externalId: "full", name: "Full", type: "http", url: "https://x", description: "d", interval: 60, timeout: 10,
      isActive: true, tags: ["a"], groups: ["g"], region: "gwc", verificationRegions: ["sea"], minConfirmingRegions: 2,
      agentId: "", method: "GET", requestBody: "", expectedStatusCodes: "200-299", expectedBody: "ok",
      customHeaders: { "X-A": "1" }, contentValidation: { enabled: true, type: "text", expectedContent: "ok" },
      followRedirects: true, verifySsl: true, enableSsl: false, basicAuthUsername: "u", basicAuthPassword: "p",
      bearerToken: "t", hostname: "h", port: 443, grpcProtoFile: "f", grpcMethod: "m",
      dnsConfig: { recordType: "A", resolver: "1.1.1.1", expectedAnswers: ["1.2.3.4"] }, retryCount: 1,
      responseTimeThreshold: 500, sslExpiryDays: 14, sslAlerts: { thirtyDays: true, fifteenDays: true, sevenDays: true, oneDay: true },
      domainMonitoringEnabled: false, domainExpiryThreshold: 30, securityAnalysisEnabled: false, securityAnalysisMode: "basic",
      alertTypes: ["down"], notifications: { email: { down: true } }, emailAddresses: "a@b.c", phoneNumbers: "",
      whatsappNumbers: "", voiceNumbers: "", voiceMode: "all", escalationPolicyId: POLICY, selectedWebhookIds: [HOOK_A],
      heartbeatIntervalSeconds: 3600, heartbeatGraceSeconds: 60, maintenanceWindows: [],
    };
    expect(() => loadConfig(cfg([all]))).not.toThrow();
  });
});

describe("diffing the full monitor", () => {
  const live: LiveMonitor = {
    publicId: "01HWLIVE000000000000000001", externalId: "api", name: "API", type: "http", url: "https://api",
    tags: ["b", "a"], alertTypes: ["down", "recovery"],
    customHeaders: { "X-A": "1", "X-B": "2" },
    sslAlerts: { thirtyDays: true, fifteenDays: false, sevenDays: true, oneDay: true },
    notifications: { email: { down: true, recovery: true } },
    escalationPolicyId: null, responseTimeThreshold: null,
  };

  it("nested objects compare by value, not key order; sets ignore order", () => {
    const diff = computeDiff({ monitors: [{
      externalId: "api", name: "API",
      tags: ["a", "b"], alertTypes: ["recovery", "down"],
      customHeaders: { "X-B": "2", "X-A": "1" },
      sslAlerts: { oneDay: true, sevenDays: true, fifteenDays: false, thirtyDays: true },
      notifications: { email: { recovery: true, down: true } },
    }] }, [live]);
    expect(diff.toUpdate).toHaveLength(0);
  });

  it("a change inside a nested object is an update of that field", () => {
    const diff = computeDiff({ monitors: [{
      externalId: "api", name: "API", sslAlerts: { thirtyDays: true, fifteenDays: true, sevenDays: true, oneDay: true },
    }] }, [live]);
    expect(diff.toUpdate[0].changedFields).toEqual(["sslAlerts"]);
  });

  it("the contract's clearing values equal the API's null", () => {
    const diff = computeDiff({ monitors: [{
      externalId: "api", name: "API", escalationPolicyId: "", responseTimeThreshold: 0,
    }] }, [live]);
    expect(diff.toUpdate).toHaveLength(0);
  });
});

describe("apply against the v1 API", () => {
  const detail = {
    publicId: "01HWLIVE000000000000000001", externalId: "api", name: "API", type: "http", url: "https://api",
    interval: 60, timeout: 30, isActive: true, tags: [], groups: [], managedBySource: "cli",
    expectedStatusCodes: "200", retryCount: 1, escalationPolicyId: POLICY, selectedWebhookIds: [HOOK_A],
  };

  it("reads the detail only for declarations that manage non-summary fields", async () => {
    const { calls, fetchImpl } = api([detail]);
    await run(cfg([{ externalId: "api", name: "API", interval: 60 }]), fetchImpl);
    expect(calls.filter((c) => c.path.startsWith("/api/v1/monitors/"))).toHaveLength(0);

    const second = api([detail]);
    const result = await run(cfg([{ externalId: "api", name: "API", expectedStatusCodes: "200-299" }]), second.fetchImpl);
    expect(second.calls.map((c) => `${c.method} ${c.path}`)).toContain("GET /api/v1/monitors/01HWLIVE000000000000000001");
    expect(result.diff.toUpdate[0].changedFields).toEqual(["expectedStatusCodes"]);
  });

  it("PATCHes only changed fields, nested objects whole", async () => {
    const { calls, fetchImpl } = api([{ ...detail, dnsConfig: { recordType: "A" } }]);
    await run(cfg([{ externalId: "api", name: "API", retryCount: 1, dnsConfig: { recordType: "MX", expectedAnswers: ["mx.a"] } }]),
      fetchImpl, { yes: true });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ dnsConfig: { recordType: "MX", expectedAnswers: ["mx.a"] } });
  });

  it("creates with every declared field, groups in a follow-up PATCH", async () => {
    const { calls, fetchImpl } = api([]);
    await run(cfg([{
      externalId: "new", name: "New", url: "https://n", timeout: 10, groups: ["Payments"],
      sslAlerts: { thirtyDays: false, fifteenDays: true, sevenDays: true, oneDay: true },
    }]), fetchImpl, { yes: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      type: "http", externalId: "new", name: "New", url: "https://n", timeout: 10,
      sslAlerts: { thirtyDays: false, fifteenDays: true, sevenDays: true, oneDay: true }, managedBySource: "cli",
    });
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/v1/monitors/01HWNEW0000000000000000001");
    expect(patch?.body).toEqual({ groups: ["Payments"] });
  });

  it("creates a heartbeat monitor without a url", async () => {
    const { calls, fetchImpl } = api([]);
    await run(cfg([{ externalId: "cron", name: "Cron", type: "heartbeat", interval: 3600, heartbeatGraceSeconds: 300 }]),
      fetchImpl, { yes: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).not.toHaveProperty("url");
    expect(post?.body).toMatchObject({ type: "heartbeat", heartbeatGraceSeconds: 300 });
  });

  it("a non-heartbeat create without url fails before anything is written", async () => {
    const { calls, fetchImpl } = api([]);
    await expect(run(cfg([{ externalId: "x", name: "X", type: "tcp" }]), fetchImpl, { yes: true }))
      .rejects.toThrow(/x: url is required to create a tcp monitor/);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});

describe("escalation policy and webhooks by name", () => {
  const policies = [
    { publicId: POLICY, name: "P1 on-call", stepCount: 2 },
    { publicId: "01HWPXSY000000000000000002", name: "Dup", stepCount: 1 },
    { publicId: "01HWPXSY000000000000000003", name: "Dup", stepCount: 1 },
  ];
  const webhooks = [
    { publicId: HOOK_A, name: "Slack #ops" },
    { publicId: HOOK_B, name: "PagerDuty" },
  ];

  it("resolves names to public ids before diffing and sending", async () => {
    const { calls, fetchImpl } = api([], { policies, webhooks });
    await run(cfg([{
      externalId: "api", name: "API", url: "https://a",
      escalationPolicyId: "P1 on-call", selectedWebhookIds: ["Slack #ops", HOOK_B],
    }]), fetchImpl, { yes: true });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({ escalationPolicyId: POLICY, selectedWebhookIds: [HOOK_A, HOOK_B] });
  });

  it("does not call the lists when only ids (or \"\") are given", async () => {
    const { calls, fetchImpl } = api([], { policies, webhooks });
    await run(cfg([{ externalId: "api", name: "API", url: "https://a", escalationPolicyId: "", selectedWebhookIds: [HOOK_A] }]),
      fetchImpl);
    expect(calls.map((c) => c.path)).not.toContain("/api/v1/escalation-policies");
    expect(calls.map((c) => c.path)).not.toContain("/api/v1/webhooks");
  });

  it("a resolved name with no drift plans nothing", async () => {
    const live = { publicId: "01HWLIVE000000000000000001", externalId: "api", name: "API", type: "http",
      url: "https://a", escalationPolicyId: POLICY, selectedWebhookIds: [HOOK_A] };
    const { fetchImpl } = api([live], { policies, webhooks });
    const result = await run(cfg([{ externalId: "api", name: "API", escalationPolicyId: "P1 on-call", selectedWebhookIds: ["Slack #ops"] }]),
      fetchImpl);
    expect(result.diff.toUpdate).toHaveLength(0);
  });

  it("unknown and ambiguous names fail with the available names", async () => {
    const one = api([], { policies, webhooks });
    await expect(run(cfg([{ externalId: "api", name: "API", url: "https://a", selectedWebhookIds: ["Teams"] }]), one.fetchImpl))
      .rejects.toThrow(/api.selectedWebhookIds: no webhook named "Teams". Available: "Slack #ops", "PagerDuty"/);
    const two = api([], { policies, webhooks });
    await expect(run(cfg([{ externalId: "api", name: "API", url: "https://a", escalationPolicyId: "Dup" }]), two.fetchImpl))
      .rejects.toThrow(/2 escalation policies are named "Dup"/);
  });
});
