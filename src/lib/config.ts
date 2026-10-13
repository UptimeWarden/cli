/**
 * ~/.uw/config.json reader/writer.
 *
 * The CLI persists three things between runs:
 *   - apiToken: a UptimeWarden API token (created in the dashboard at
 *     /settings/api-tokens). The CLI never sees the user's password.
 *   - baseUrl: API base, defaulting to https://app.uptimewarden.online.
 *     Override for self-hosted / staging clusters.
 *   - workspace: optional human-readable label included in audit log
 *     entries on every CLI write. Lets multi-environment users
 *     distinguish "acme-prod" from "acme-staging" in the audit trail.
 *
 * Env vars override file values so CI / containers don't have to manage
 * a config file at all:
 *   - UW_API_TOKEN
 *   - UW_API_URL (UW_BASE_URL is read as an alias; UW_API_URL wins)
 *   - UW_WORKSPACE
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CliConfig {
  apiToken?: string;
  baseUrl?: string;
  workspace?: string;
}

const DEFAULT_BASE_URL = "https://app.uptimewarden.online";

export function getConfigPath(override?: string): string {
  if (override) return override;
  // Allow tests + container users to point the config dir elsewhere.
  if (process.env.UW_CONFIG_DIR) {
    return join(process.env.UW_CONFIG_DIR, "config.json");
  }
  return join(homedir(), ".uw", "config.json");
}

export function readConfig(path?: string): CliConfig {
  const file = getConfigPath(path);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as CliConfig;
  } catch {
    // A corrupt config file should not crash --help / --version. Treat it
    // as empty and let `uw auth login` overwrite cleanly.
    return {};
  }
}

export function writeConfig(config: CliConfig, path?: string): string {
  const file = getConfigPath(path);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // Defense in depth: ensure mode is 0600 even if umask was permissive.
  try { chmodSync(file, 0o600); } catch { /* non-POSIX FS — best effort */ }
  return file;
}

/**
 * Resolve effective config: env vars beat the file. Used by every command
 * that touches the network so we don't have to thread args through.
 */
export function resolveConfig(path?: string): Required<Pick<CliConfig, "baseUrl">> & CliConfig {
  const file = readConfig(path);
  return {
    apiToken: process.env.UW_API_TOKEN ?? file.apiToken,
    baseUrl: process.env.UW_API_URL || process.env.UW_BASE_URL || file.baseUrl || DEFAULT_BASE_URL,
    workspace: process.env.UW_WORKSPACE ?? file.workspace,
  };
}
