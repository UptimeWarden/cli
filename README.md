# @uptimewarden/cli

Monitoring-as-Code CLI for [UptimeWarden](https://uptimewarden.online).

> **Alpha.** Commands: `auth`, `heartbeat`, `apply`. The first npm release is
> coming soon; until then, build from source (see [Development](#development)).

## Install

```bash
npm install -g @uptimewarden/cli
# or run without installing:
npx @uptimewarden/cli --help
```

Requires Node.js 20 or later. Binary name: `uw` (alias: `uptimewarden`).

## Quick start

```bash
# 1. Create an API token at https://app.uptimewarden.online/settings/api-tokens
uw auth login --token uptw_xxx

# 2. Send a heartbeat ping (for cron jobs and scheduled CI):
uw heartbeat <heartbeat-token>

# 3. Compare a Monitoring-as-Code file with your live monitors:
uw apply -f monitors.uw.json

# 4. Apply the changes:
uw apply -f monitors.uw.json --yes
```

## Config file

```json
{
  "monitors": [
    {
      "externalId": "api-prod",
      "name": "API (production)",
      "type": "http",
      "url": "https://api.example.com/health",
      "interval": 60,
      "timeout": 10,
      "expectedStatusCodes": "200-299",
      "customHeaders": { "X-Probe": "uptimewarden" },
      "responseTimeThreshold": 800,
      "sslAlerts": { "thirtyDays": false, "fifteenDays": true, "sevenDays": true, "oneDay": true },
      "alertTypes": ["down", "recovery"],
      "emailAddresses": "oncall@example.com",
      "escalationPolicyId": "P1 on-call",
      "selectedWebhookIds": ["Slack #ops"]
    },
    {
      "externalId": "nightly-backup",
      "name": "Nightly backup",
      "type": "heartbeat",
      "interval": 86400,
      "heartbeatGraceSeconds": 1800
    }
  ]
}
```

`externalId` is the stable key the CLI uses to match a declaration with a
live monitor. The CLI only manages monitors it created (`managedBySource=cli`)
and reads all of them, page by page, before planning.

Every other field is a `/api/v1/monitors` field under the API's own name, with
the API's rules (the API reference lists them). A field left out of the file
is not managed: the CLI neither sends it nor reports drift on it. A field the
API does not know is rejected before anything is sent.

| Group | Fields |
|---|---|
| Required | `externalId`, `name`; `url` to create any type except `heartbeat` (UptimeWarden sets a heartbeat's url, so do not give one) |
| Basics | `type` (default `http`: `http`, `tcp`, `udp`, `ssl`, `websocket`, `mcp`, `grpc`, `ping`, `dns`, `heartbeat`), `description`, `interval`, `timeout`, `isActive`, `tags`, `groups` |
| Regions | `region` (`ae` Sydney, `brs` São Paulo, `gwc` Sweden Central, `sea` East Asia, `wus3` Phoenix; choosing one needs region selection on your plan), `verificationRegions`, `minConfirmingRegions`, `agentId` |
| Check settings | `method`, `requestBody`, `expectedStatusCodes`, `expectedBody`, `customHeaders`, `contentValidation`, `followRedirects`, `verifySsl`, `enableSsl`, `basicAuthUsername`, `basicAuthPassword`, `bearerToken`, `hostname`, `port`, `grpcProtoFile`, `grpcMethod`, `dnsConfig` (`recordType`, `resolver`, `expectedAnswers`) |
| Thresholds | `retryCount`, `responseTimeThreshold` (50–5000 ms, `0` = off), `sslExpiryDays`, `sslAlerts`, `domainMonitoringEnabled`, `domainExpiryThreshold`, `securityAnalysisEnabled`, `securityAnalysisMode` |
| Alert routing | `alertTypes`, `notifications` (channel → alert type → bool), `emailAddresses`, `phoneNumbers`, `whatsappNumbers`, `voiceNumbers` (comma-separated), `voiceMode` (`sequential` or `all`), `escalationPolicyId`, `selectedWebhookIds` |
| Heartbeat and maintenance | `heartbeatIntervalSeconds`, `heartbeatGraceSeconds`, `maintenanceWindows` |

How the diff treats them:

- Nested objects (`customHeaders`, `sslAlerts`, `dnsConfig`, …) are compared
  by value; a change sends the whole object.
- `tags`, `groups`, `alertTypes` and `selectedWebhookIds` ignore order.
- The clearing values `""` (`escalationPolicyId`, `externalId`,
  `description`), `0` (`responseTimeThreshold`) and `[]` match the API's
  null, so they do not show as drift once applied.
- Fields beyond the list view (thresholds, routing, …) are compared against
  the monitor's full record, read once per declared monitor that uses them.
- `groups` is set right after a create (the API sets groups on update only).

### Escalation policies and webhooks by name

`escalationPolicyId` and `selectedWebhookIds` take public ids (ULIDs) or names.
A name is looked up in `GET /api/v1/escalation-policies` or
`GET /api/v1/webhooks` and must match exactly one item; otherwise the run
stops and lists the names that exist. `""` detaches the policy and `[]`
detaches all webhooks.

### Type changes

A `type` change is applied in place (PATCH), except to or from `heartbeat`,
which the API cannot do. Those show as a **replace**: the old monitor is
deleted (with its history) and a new one is created with the same
`externalId`. Because that deletes a monitor, it only runs with
`--allow-delete`. Without it the change is shown as blocked and
`uw apply --yes` applies everything else, then exits 1.

## Commands

| Command | Description |
|---|---|
| `uw auth login --token <token>` | Save the API token to `~/.uw/config.json` (mode 0600) |
| `uw auth status` | Show whether a token is configured (never prints the token) |
| `uw auth logout` | Remove the saved token |
| `uw heartbeat <token>` | Send a heartbeat ping (`POST /api/heartbeat/:token/ping`) |
| `uw heartbeat <token> --state failure [--message <text>]` | Report a failure (`POST /api/heartbeat/:token/fail`); the message (at most 500 characters) becomes the incident's error |
| `uw apply -f <file>` | Show the plan for a config file. Nothing is written without `--yes` |
| `uw apply -f <file> --yes` | Apply creates and updates |
| `uw apply -f <file> --yes --allow-delete` | Also delete CLI-managed monitors that are not in the file, and replace monitors whose `type` changes to or from `heartbeat` |
| `uw apply -f <file> --diff-only` | Exit 2 when there is drift (for PR checks) |
| `uw apply -f <file> --json` | Print the plan as JSON (with `--yes`: the result, with progress on stderr) |
| `uw --version` / `uw --help` | Work offline |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success; with `--diff-only`, no drift |
| `1` | Error, or `--yes` left a type change blocked |
| `2` | `--diff-only` found drift |

### JSON plan

`uw apply -f monitors.uw.json --json` prints:

```json
{
  "applied": false,
  "hasDrift": true,
  "allowDelete": false,
  "create":  [{ "externalId": "api-prod", "name": "API (production)", "type": "http" }],
  "update":  [{ "externalId": "web", "publicId": "01H…", "changedFields": ["interval"] }],
  "replace": [{ "externalId": "db", "publicId": "01H…", "fromType": "http", "toType": "heartbeat", "changedFields": ["type"], "blocked": true }],
  "delete":  [{ "externalId": "old", "publicId": "01H…", "name": "Old", "blocked": true }]
}
```

### Heartbeats

```bash
# At the end of a successful run:
uw heartbeat "$UW_HEARTBEAT_TOKEN"

# When the job fails: the incident opens now (within about 30 seconds)
# instead of after the interval and grace.
uw heartbeat "$UW_HEARTBEAT_TOKEN" --state failure --message "pg_dump exited 1"
```

The token is the monitor's heartbeat token (dashboard, or `heartbeat_token` in
the Terraform provider). The endpoint needs no API token.

## Environment variables

These override the values in `~/.uw/config.json`:

| Variable | Purpose |
|---|---|
| `UW_API_TOKEN` | API token |
| `UW_API_URL` | API base URL (default `https://app.uptimewarden.online`). `UW_BASE_URL` is read as an alias; the Terraform provider and the GitHub Actions use the same names |
| `UW_WORKSPACE` | Workspace label included in audit-log entries |
| `UW_CONFIG_DIR` | Config directory (default `~/.uw`) |

## GitHub Actions

[`uptimewarden/actions/sync-monitors`](https://github.com/UptimeWarden/actions/tree/main/sync-monitors)
runs this CLI in a workflow: `diff` on pull requests, `apply` on push.

## Development

```bash
npm ci
npm run typecheck
npm test          # vitest, no network needed
npm run build     # tsup -> dist/index.js
node dist/index.js --help
```

Releases are described in [RELEASING.md](./RELEASING.md).

## License

Apache-2.0. See [LICENSE](./LICENSE).
