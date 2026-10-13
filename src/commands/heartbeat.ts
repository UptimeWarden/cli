/**
 * `uw heartbeat <token>` — POST /api/heartbeat/:token/ping, or
 * `uw heartbeat <token> --state failure` — POST /api/heartbeat/:token/fail
 *
 * Mirrors the GitHub Action so users can drop the same call into their
 * own scripts (or test the action's payload locally before wiring it up
 * to GHA). The endpoint is anonymous, so this command does NOT require
 * `uw auth login` to have run.
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

const KNOWN_STATES = new Set(["success", "failure"]);

/** The API stores at most this many characters of a failure message. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * success → POST /api/heartbeat/:token/ping
 * failure → POST /api/heartbeat/:token/fail (the message becomes the
 *           incident's error; the incident opens at the scheduler's next
 *           tick, within about 30 seconds).
 */
export async function runHeartbeat(token: string, opts: HeartbeatOptions = {}): Promise<{ status: number; url: string }> {
  if (!token || token.trim().length === 0) {
    throw new Error("Heartbeat token is required. Usage: uw heartbeat <token>");
  }
  const state = opts.state ?? "success";
  if (!KNOWN_STATES.has(state)) {
    throw new Error(`--state must be "success" or "failure" (got "${state}")`);
  }
  if (opts.message !== undefined && opts.message.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`--message is ${opts.message.length} characters; the API keeps at most ${MAX_MESSAGE_LENGTH}`);
  }
  const client = createClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  const payload: Record<string, unknown> = {};
  if (opts.message) payload.message = opts.message;
  return client.heartbeatPing(token, payload, state === "failure" ? "fail" : "ping");
}

export function registerHeartbeatCommand(program: Command): void {
  program
    .command("heartbeat <token>")
    .description("Send a heartbeat ping, or report a failure (no auth required — token IS the auth)")
    .option("--state <state>", "success (ping) or failure (opens an incident now)", "success")
    .option("--message <text>", `Optional message (at most ${MAX_MESSAGE_LENGTH} characters); on failure it becomes the incident's error`)
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
