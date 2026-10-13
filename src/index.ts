#!/usr/bin/env node
/**
 * @uptimewarden/cli — entrypoint.
 *
 * Commands: auth, heartbeat, apply. Every command is registered through
 * commander so `uw --help` and `uw <cmd> --help` work without any network
 * access, which keeps them usable in CI smoke tests.
 */
import { Command } from "commander";
import { registerAuthCommand } from "./commands/auth.js";
import { registerHeartbeatCommand } from "./commands/heartbeat.js";
import { registerApplyCommand } from "./commands/apply.js";
import { VERSION } from "./version.js";

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("uw")
    .description("UptimeWarden CLI — Monitoring as Code, heartbeat pings, drift detection.")
    .version(VERSION, "-v, --version", "print the CLI version");

  registerAuthCommand(program);
  registerHeartbeatCommand(program);
  registerApplyCommand(program);

  return program;
}

// Only auto-parse when invoked directly. Tests import buildProgram and
// drive it themselves so they don't trigger process.exit.
const invokedDirectly =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (typeof process !== "undefined" && process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href);

if (invokedDirectly) {
  buildProgram().parseAsync(process.argv).catch((err) => {
    process.stderr.write(`ERR ${(err as Error).message}\n`);
    process.exit(1);
  });
}
