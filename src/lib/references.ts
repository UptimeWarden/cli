/**
 * Name → public id for the references a monitor carries.
 *
 * escalationPolicyId and selectedWebhookIds take public ids (ULIDs). A config
 * may give a name instead ("P1 on-call", "Slack #ops"); it is looked up in
 * GET /api/v1/escalation-policies or /api/v1/webhooks. A name must match
 * exactly one item. "" (detach) and [] are left alone.
 */
import type { Client } from "./client.js";
import { ULID_RE } from "./monitor-fields.js";

interface Named {
  publicId: string;
  name: string;
}

function listOf(payload: unknown): Named[] {
  const data = Array.isArray(payload) ? payload : (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as Named[]) : [];
}

function resolveName(kind: string, plural: string, value: string, items: Named[], where: string): string {
  if (value === "" || ULID_RE.test(value)) return value;
  const matches = items.filter((i) => i.name === value);
  if (matches.length === 1) return matches[0].publicId;
  if (matches.length > 1) {
    throw new Error(`${where}: ${matches.length} ${plural} are named "${value}"; use the public id instead`);
  }
  const names = items.map((i) => `"${i.name}"`).join(", ");
  throw new Error(
    `${where}: no ${kind} named "${value}"` + (names ? `. Available: ${names}` : `; this account has none`),
  );
}

export async function resolveReferences<T extends { monitors: Array<Record<string, unknown> & { externalId: string }> }>(
  client: Client,
  config: T,
): Promise<T> {
  const needsPolicies = config.monitors.some(
    (m) => typeof m.escalationPolicyId === "string" && m.escalationPolicyId !== "" && !ULID_RE.test(m.escalationPolicyId),
  );
  const needsWebhooks = config.monitors.some(
    (m) => Array.isArray(m.selectedWebhookIds) &&
      m.selectedWebhookIds.some((v) => typeof v === "string" && !ULID_RE.test(v)),
  );
  if (!needsPolicies && !needsWebhooks) return config;

  const policies = needsPolicies ? listOf(await client.get<unknown>("/api/v1/escalation-policies")) : [];
  const webhooks = needsWebhooks ? listOf(await client.get<unknown>("/api/v1/webhooks")) : [];

  const monitors = config.monitors.map((m) => {
    const out = { ...m };
    if (typeof m.escalationPolicyId === "string") {
      out.escalationPolicyId = resolveName("escalation policy", "escalation policies", m.escalationPolicyId, policies, `${m.externalId}.escalationPolicyId`);
    }
    if (Array.isArray(m.selectedWebhookIds)) {
      out.selectedWebhookIds = m.selectedWebhookIds.map((v) =>
        typeof v === "string" ? resolveName("webhook", "webhooks", v, webhooks, `${m.externalId}.selectedWebhookIds`) : v,
      );
    }
    return out;
  });
  return { ...config, monitors };
}
