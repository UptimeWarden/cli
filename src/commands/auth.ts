/**
 * `uw auth login` / `uw auth status` / `uw auth logout`
 *
 * Takes the API token directly via the `--token` flag or the UW_API_TOKEN
 * environment variable. Users create the token in the dashboard at
 * /settings/api-tokens; the CLI stores it and never sees a password.
 */
import pc from "picocolors";
import { Command } from "commander";
import { readConfig, writeConfig, resolveConfig } from "../lib/config.js";

export interface AuthLoginOptions {
  token?: string;
  baseUrl?: string;
  workspace?: string;
  /** Override homedir for tests. */
  configPath?: string;
}

export async function runAuthLogin(opts: AuthLoginOptions): Promise<{ ok: boolean; configFile: string }> {
  const token = opts.token ?? process.env.UW_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing --token. Create one at /settings/api-tokens and pass it via\n" +
        "  uw auth login --token uptw_xxx\n" +
        "  (or export UW_API_TOKEN=uptw_xxx)",
    );
  }
  const existing = readConfig(opts.configPath);
  const next = {
    ...existing,
    apiToken: token,
    baseUrl: opts.baseUrl ?? existing.baseUrl,
    workspace: opts.workspace ?? existing.workspace,
  };
  const file = writeConfig(next, opts.configPath);
  return { ok: true, configFile: file };
}

export function authStatus(configPath?: string): { authenticated: boolean; baseUrl: string; workspace?: string } {
  // resolveConfig() already merges env + file. We just don't expose the
  // token here — callers should never log raw token material.
  const cfg = resolveConfig(configPath);
  return {
    authenticated: Boolean(cfg.apiToken),
    baseUrl: cfg.baseUrl,
    workspace: cfg.workspace,
  };
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command("auth").description("Manage CLI authentication");

  auth
    .command("login")
    .description("Save an API token to ~/.uw/config.json")
    .option("-t, --token <token>", "API token (or set UW_API_TOKEN)")
    .option("--base-url <url>", "Override API base URL (self-hosted / staging)")
    .option("--workspace <name>", "Optional workspace label for audit logs")
    .action(async (opts: AuthLoginOptions) => {
      try {
        const { configFile } = await runAuthLogin(opts);
        process.stdout.write(pc.green("OK ") + `Token saved to ${configFile}\n`);
      } catch (err) {
        process.stderr.write(pc.red("ERR ") + (err as Error).message + "\n");
        process.exitCode = 1;
      }
    });

  auth
    .command("status")
    .description("Show current authentication status (no secrets printed)")
    .action(() => {
      const s = authStatus();
      if (s.authenticated) {
        process.stdout.write(
          pc.green("authenticated ") +
            `base=${s.baseUrl}` +
            (s.workspace ? ` workspace=${s.workspace}` : "") +
            "\n",
        );
      } else {
        process.stdout.write(pc.yellow("not authenticated ") + "run `uw auth login --token <token>`\n");
      }
    });

  auth
    .command("logout")
    .description("Remove saved API token")
    .action(() => {
      const cfg = readConfig();
      delete cfg.apiToken;
      writeConfig(cfg);
      process.stdout.write(pc.green("OK ") + "logged out\n");
    });
}
