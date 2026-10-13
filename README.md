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
      "interval": 60
    }
  ]
}
```

`externalId` is the stable key the CLI uses to match a declaration with a
live monitor. The CLI only manages monitors it created (`managedBySource=cli`)
and reads all of them, page by page, before planning.

| Field | Required | Notes |
|---|---|---|
| `externalId` | yes | Stable key, unique per file |
| `name` | yes | |
| `type` | no (create defaults to `http`) | `http`, `tcp`, `udp`, `ssl`, `websocket`, `grpc`, `mcp`, `ping`, `dns`, `heartbeat`. See [Type changes](#type-changes) |
| `url` | no | Target URL or address |
| `interval` | no | Seconds; your plan sets the minimum |
| `timeout` | no | Seconds (API default 30) |
| `region` | no | `ae` (Sydney), `brs` (São Paulo), `gwc` (Sweden Central), `sea` (East Asia), `wus3` (Phoenix). Choosing a region needs Professional or Enterprise |
| `isActive` | no | Defaults to `true` |

A field left out of the file is not managed: the CLI neither sends it nor
reports drift on it.

### Type changes

The API cannot change the type of an existing monitor. When `type` changes,
the plan shows a **replace**: the old monitor is deleted (with its history)
and a new one is created with the same `externalId`. Because that deletes a
monitor, it only runs with `--allow-delete`. Without it the change is shown as
blocked and `uw apply --yes` applies everything else, then exits 1.

## Commands

| Command | Description |
|---|---|
| `uw auth login --token <token>` | Save the API token to `~/.uw/config.json` (mode 0600) |
| `uw auth status` | Show whether a token is configured (never prints the token) |
| `uw auth logout` | Remove the saved token |
| `uw heartbeat <token>` | Send a heartbeat ping (`POST /api/heartbeat/:token/ping`) |
| `uw heartbeat <token> --state failure` | Not supported yet: exits 1 without sending anything (see below) |
| `uw apply -f <file>` | Show the plan for a config file. Nothing is written without `--yes` |
| `uw apply -f <file> --yes` | Apply creates and updates |
| `uw apply -f <file> --yes --allow-delete` | Also delete CLI-managed monitors that are not in the file, and replace monitors whose `type` changed |
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
  "replace": [{ "externalId": "db", "publicId": "01H…", "fromType": "http", "toType": "tcp", "changedFields": ["type"], "blocked": true }],
  "delete":  [{ "externalId": "old", "publicId": "01H…", "name": "Old", "blocked": true }]
}
```

### Heartbeat failures

The heartbeat endpoint records every ping as a success; it cannot record a
failure yet. So `uw heartbeat --state failure` exits 1 and sends nothing,
rather than reporting a failed job as healthy. To report a failure today,
skip the ping: the monitor alerts when the heartbeat is overdue.

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
