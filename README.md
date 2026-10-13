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
live monitor. The CLI only manages monitors it created (`managedBySource=cli`).

## Commands

| Command | Description |
|---|---|
| `uw auth login --token <token>` | Save the API token to `~/.uw/config.json` (mode 0600) |
| `uw auth status` | Show whether a token is configured (never prints the token) |
| `uw auth logout` | Remove the saved token |
| `uw heartbeat <token>` | Send a heartbeat ping (`POST /api/heartbeat/:token/ping`) |
| `uw apply -f <file>` | Show the plan for a config file. Nothing is written without `--yes` |
| `uw apply -f <file> --yes` | Apply creates and updates |
| `uw apply -f <file> --yes --allow-delete` | Also delete CLI-managed monitors that are not in the file |
| `uw apply -f <file> --diff-only` | Exit 2 when there is drift (for PR checks) |
| `uw --version` / `uw --help` | Work offline |

## Environment variables

These override the values in `~/.uw/config.json`:

| Variable | Purpose |
|---|---|
| `UW_API_TOKEN` | API token |
| `UW_API_URL` | API base URL (default `https://app.uptimewarden.online`) |
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
