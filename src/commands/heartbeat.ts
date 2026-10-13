/**
 * `uw heartbeat <token>` — POST /api/heartbeat/:token/ping
 *
 * Mirrors the GitHub Action so users can drop the same call into their
 * own scripts (or test the action's payload locally before wiring it up
 * to GHA). The endpoint is anonymous, so this command does NOT require
 * `uw auth login` to have run.
 *
 * `--state failure` is refused: the heartbeat endpoint records every ping as
 * a success, so sending one for a failed job would report it healthy.
 */
import pc from "picocolors";
import { Command } from "commander";
import { createClient, ApiError } from "../lib/client.js";

export interface HeartbeatOptions {
  baseUrl?: string;
  state?: "success" | "failure";
  message?: string;
  /** Tests inject a stub fetch here. */
  fetchImpl?: typeof fetch;
}

/** Thrown for a state the server cannot record yet. Nothing is sent. */
export class UnsupportedHeartbeatStateError extends Error {
  constructor(state: string) {
    super(
      `--state ${state} is not supported yet: the heartbeat endpoint records every ping as a success, ` +
        `so nothing was sent. To report a failed job, skip the ping; the monitor alerts when the ` +
        `heartbeat is overdue.`,
    );
    this.name = "UnsupportedHeartbeatStateError";
  }
}

const KNOWN_STATES = new Set(["success", "failure"]);

export async function runHeartbeat(token: string, opts: HeartbeatOptions = {}): Promise<{ status: number; url: string }> {
  if (!token || token.trim().length === 0) {
    throw new Error("Heartbeat token is required. Usage: uw heartbeat <token>");
  }
  if (opts.state !== undefined && !KNOWN_STATES.has(opts.state)) {
    throw new Error(`--state must be "success" or "failure" (got "${opts.state}")`);
  }
  if (opts.state === "failure") {
    throw new UnsupportedHeartbeatStateError(opts.state);
  }
  const client = createClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  const payload: Record<string, unknown> = {};
  if (opts.state) payload.state = opts.state;
  if (opts.message) payload.message = opts.message;
  return client.heartbeatPing(token, payload);
}

export function registerHeartbeatCommand(program: Command): void {
  program
    .command("heartbeat <token>")
    .description("Send a heartbeat ping (no auth required — token IS the auth)")
    .option("--state <state>", "Reported state: success (failure is not supported yet and exits 1)", "success")
    .option("--message <text>", "Optional human-readable message attached to the ping")
    .option("--base-url <url>", "Override API base URL")
    .action(async (token: string, opts: HeartbeatOptions) => {
      try {
        const { status, url } = await runHeartbeat(token, opts);
        process.stdout.write(pc.green("OK ") + `${status} ${url}\n`);
      } catch (err) {
        if (err instanceof ApiError) {
          process.stderr.write(pc.red("ERR ") + `${err.status} ${err.url}\n`);
        } else {
          process.stderr.write(pc.red("ERR ") + (err as Error).message + "\n");
        }
        process.exitCode = 1;
      }
    });
}
