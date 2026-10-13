/**
 * The monitor fields `uw apply` understands: the /api/v1/monitors fields,
 * under the API's own camelCase names.
 *
 * The API rejects unknown fields, so the CLI checks a config against this
 * list before sending anything; a typo fails with the field's name instead
 * of a 400 halfway through an apply.
 */

/** Fields POST /api/v1/monitors accepts (besides managedBySource, which the CLI sets). */
export const CREATE_FIELDS = [
  // Required
  "name", "type", "url",
  // Basics
  "description", "interval", "timeout", "isActive", "tags", "externalId",
  // Where it is checked from
  "region", "verificationRegions", "minConfirmingRegions", "agentId",
  // Check settings
  "method", "requestBody", "expectedStatusCodes", "expectedBody", "customHeaders", "contentValidation",
  "followRedirects", "verifySsl", "enableSsl", "basicAuthUsername", "basicAuthPassword", "bearerToken",
  "hostname", "port", "grpcProtoFile", "grpcMethod", "dnsConfig",
  // Thresholds
  "retryCount", "responseTimeThreshold", "sslExpiryDays", "sslAlerts", "domainMonitoringEnabled",
  "domainExpiryThreshold", "securityAnalysisEnabled", "securityAnalysisMode",
  // Alert routing
  "alertTypes", "notifications", "emailAddresses", "phoneNumbers", "whatsappNumbers", "voiceNumbers",
  "voiceMode", "escalationPolicyId", "selectedWebhookIds",
  // Heartbeat and maintenance
  "heartbeatIntervalSeconds", "heartbeatGraceSeconds", "maintenanceWindows",
] as const;

/** PATCH accepts the create fields plus groups. */
export const PATCH_ONLY_FIELDS = ["groups"] as const;

/** Every field a declaration may carry. */
export const DECLARATION_FIELDS: ReadonlySet<string> = new Set<string>([
  ...CREATE_FIELDS,
  ...PATCH_ONLY_FIELDS,
]);

/** Fields present on GET /api/v1/monitors list rows; anything else needs the detail read. */
export const SUMMARY_FIELDS: ReadonlySet<string> = new Set([
  "publicId", "name", "type", "externalId", "url", "interval", "timeout", "isActive", "region",
  "hostname", "tags", "groups", "managedBySource",
]);

/** Arrays whose order does not matter. */
export const SET_FIELDS: ReadonlySet<string> = new Set(["tags", "groups", "alertTypes", "selectedWebhookIds"]);

export const MONITOR_TYPES = [
  "http", "tcp", "udp", "ssl", "websocket", "mcp", "grpc", "ping", "dns", "heartbeat",
] as const;

/**
 * Values a client sends to clear a field ("" detaches a policy or clears
 * externalId, 0 turns responseTimeThreshold off, [] detaches webhooks). The
 * API answers null for them, so null live equals an empty declaration.
 */
function isEmpty(v: unknown): boolean {
  return v === "" || v === 0 || (Array.isArray(v) && v.length === 0) ||
    (v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canonical(x);
    }
    return out;
  }
  return v;
}

/** Deep, key-order-insensitive equality; set fields ignore element order. */
export function fieldEqual(field: string, desired: unknown, live: unknown): boolean {
  if (live === null || live === undefined) {
    return desired === null || isEmpty(desired);
  }
  if (SET_FIELDS.has(field) && Array.isArray(desired) && Array.isArray(live)) {
    const a = [...desired].map(String).sort();
    const b = [...live].map(String).sort();
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return JSON.stringify(canonical(desired)) === JSON.stringify(canonical(live));
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
