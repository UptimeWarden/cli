/**
 * `uw apply -f <file>` — Monitoring-as-Code apply command.
 *
 * Reads a JSON config, diffs it against the live CLI-managed state, and
 * either prints a plan (default / dry-run) or applies it (--yes).
 *
 * Flags:
 *   -f, --file <path>     Config file (JSON with { monitors: [...] })
 *   --yes                 Apply changes. Without this flag the command
 *                         is always dry-run and exits 0.
 *   --allow-delete        Enable deletion of monitors no longer in the
 *                         config. Without this flag deletes are shown in
 *                         the plan but never applied — prevents footgun.
 *   --diff-only           Exit 0 when no drift, exit 2 when drift detected.
 *                         Useful for PR gate: fail if config is out of sync.
 *   --base-url <url>      Override API base URL.
 */
import { existsSync, readFileSync } from "node:fs";
import pc from "picocolors";
import { Command } from "commander";
import { createClient, ApiError } from "../lib/client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MonitorDeclaration {
  externalId: string;
  name: string;
  type?: string;
  url?: string;
  interval?: number;
  timeout?: number;
  region?: string;
  isActive?: boolean;
}

export interface LiveMonitor {
  publicId: string;
  externalId: string;
  name: string;
  type?: string;
  url?: string;
  interval?: number;
  timeout?: number;
  region?: string;
  isActive?: boolean;
}

export interface DesiredConfig {
  workspace?: string;
  monitors: MonitorDeclaration[];
}

export interface ApplyDiff {
  toCreate: MonitorDeclaration[];
  toUpdate: Array<{ desired: MonitorDeclaration; live: LiveMonitor; changedFields: string[] }>;
  toDelete: LiveMonitor[];
}

export interface ApplyOptions {
  file: string;
  yes?: boolean;
  allowDelete?: boolean;
  diffOnly?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface ApplyResult {
  diff: ApplyDiff;
  applied: boolean;
  created: number;
  updated: number;
  deleted: number;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadConfig(file: string): DesiredConfig {
  if (!existsSync(file)) {
    throw new Error(`Config file not found: ${file}`);
  }
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as DesiredConfig;
  if (!Array.isArray(parsed.monitors)) {
    throw new Error(`Config must contain { "monitors": [...] }`);
  }
  for (const m of parsed.monitors) {
    if (!m.externalId || !m.name) {
      throw new Error(
        `Every monitor must have externalId + name. Offending entry: ${JSON.stringify(m)}`,
      );
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Fields we compare for drift detection. */
const TRACKED_FIELDS: Array<keyof MonitorDeclaration> = [
  "name", "type", "url", "interval", "timeout", "region", "isActive",
];

function changedFields(desired: MonitorDeclaration, live: LiveMonitor): string[] {
  return TRACKED_FIELDS.filter((k) => {
    const d = desired[k];
    const l = (live as unknown as Record<string, unknown>)[k];
    // undefined in desired = "not managed" — don't flag as changed
    if (d === undefined) return false;
    return d !== l;
  });
}

export function computeDiff(
  desired: DesiredConfig,
  live: LiveMonitor[],
): ApplyDiff {
  const liveByExt = new Map(live.map((m) => [m.externalId, m] as const));
  const desiredIds = new Set(desired.monitors.map((m) => m.externalId));

  const toCreate: MonitorDeclaration[] = [];
  const toUpdate: ApplyDiff["toUpdate"] = [];
  for (const m of desired.monitors) {
    const found = liveByExt.get(m.externalId);
    if (!found) {
      toCreate.push(m);
    } else {
      const changed = changedFields(m, found);
      if (changed.length > 0) {
        toUpdate.push({ desired: m, live: found, changedFields: changed });
      }
    }
  }
  const toDelete = live.filter((m) => !desiredIds.has(m.externalId));
  return { toCreate, toUpdate, toDelete };
}

// ---------------------------------------------------------------------------
// Apply (write path)
// ---------------------------------------------------------------------------

async function applyDiff(
  diff: ApplyDiff,
  opts: Pick<ApplyOptions, "allowDelete" | "baseUrl" | "fetchImpl">,
): Promise<{ created: number; updated: number; deleted: number }> {
  const client = createClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  let created = 0;
  let updated = 0;
  let deleted = 0;

  for (const m of diff.toCreate) {
    process.stdout.write(`  ${pc.green("+")} creating ${pc.bold(m.name)} (${m.externalId})…\n`);
    await client.post("/api/v1/monitors", {
      name: m.name,
      type: m.type ?? "http",
      url: m.url ?? "",
      interval: m.interval,
      timeout: m.timeout,
      region: m.region,
      isActive: m.isActive,
      externalId: m.externalId,
      managedBySource: "cli",
    });
    created++;
    process.stdout.write(`    ${pc.green("✓")} created\n`);
  }

  for (const { desired, live, changedFields: fields } of diff.toUpdate) {
    process.stdout.write(
      `  ${pc.yellow("~")} updating ${pc.bold(live.name)} (${live.externalId}) [${fields.join(", ")}]…\n`,
    );
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      body[f] = desired[f as keyof MonitorDeclaration];
    }
    await client.patch(`/api/v1/monitors/${live.publicId}`, body);
    updated++;
    process.stdout.write(`    ${pc.yellow("✓")} updated\n`);
  }

  if (diff.toDelete.length > 0 && !opts.allowDelete) {
    process.stdout.write(
      pc.yellow(
        `\n  ${diff.toDelete.length} monitor(s) would be deleted but --allow-delete was not set.\n` +
          `  Re-run with --allow-delete to remove them.\n`,
      ),
    );
  } else {
    for (const m of diff.toDelete) {
      process.stdout.write(`  ${pc.red("-")} deleting ${pc.bold(m.name)} (${m.externalId})…\n`);
      await client.delete(`/api/v1/monitors/${m.publicId}`);
      deleted++;
      process.stdout.write(`    ${pc.red("✓")} deleted\n`);
    }
  }

  return { created, updated, deleted };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

/** Accept either a bare array or the v1 `{ success, data }` envelope. */
export function asLiveMonitors(payload: unknown): LiveMonitor[] {
  if (Array.isArray(payload)) return payload as LiveMonitor[];
  if (payload && typeof payload === "object") {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as LiveMonitor[];
  }
  return [];
}

export async function runApply(opts: ApplyOptions): Promise<ApplyResult> {
  const desired = loadConfig(opts.file);
  const client = createClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  const live = asLiveMonitors(
    await client
      .get<unknown>(`/api/v1/monitors?managedBySource=cli`)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      }),
  );

  const diff = computeDiff(desired, live);

  if (!opts.yes) {
    return { diff, applied: false, created: 0, updated: 0, deleted: 0 };
  }

  const { created, updated, deleted } = await applyDiff(diff, opts);
  return { diff, applied: true, created, updated, deleted };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPlan(diff: ApplyDiff, allowDelete: boolean): string {
  const lines: string[] = [];
  lines.push(pc.bold("Plan:"));
  lines.push(`  ${pc.green("+")} create  ${diff.toCreate.length}`);
  lines.push(`  ${pc.yellow("~")} update  ${diff.toUpdate.length}`);
  const deleteNote = !allowDelete && diff.toDelete.length > 0 ? pc.dim(" (requires --allow-delete)") : "";
  lines.push(`  ${pc.red("-")} delete  ${diff.toDelete.length}${deleteNote}`);
  for (const m of diff.toCreate) {
    lines.push(`    ${pc.green("+")} ${m.externalId} (${m.name})`);
  }
  for (const u of diff.toUpdate) {
    lines.push(`    ${pc.yellow("~")} ${u.desired.externalId} — changed: ${u.changedFields.join(", ")}`);
  }
  for (const m of diff.toDelete) {
    lines.push(`    ${pc.red("-")} ${m.externalId} (${m.name})`);
  }
  return lines.join("\n");
}

export function formatApplied(result: ApplyResult): string {
  const { created, updated, deleted } = result;
  const parts: string[] = [];
  if (created > 0) parts.push(pc.green(`${created} created`));
  if (updated > 0) parts.push(pc.yellow(`${updated} updated`));
  if (deleted > 0) parts.push(pc.red(`${deleted} deleted`));
  if (parts.length === 0) return pc.dim("No changes.");
  return pc.bold("Applied: ") + parts.join(", ");
}

// ---------------------------------------------------------------------------
// Commander registration
// ---------------------------------------------------------------------------

export function registerApplyCommand(program: Command): void {
  program
    .command("apply")
    .description("Diff (or apply) a MaC config against live state")
    .requiredOption("-f, --file <path>", "Path to config file (JSON)")
    .option("--yes", "Apply changes — without this flag the run is always dry-run")
    .option("--allow-delete", "Allow deletion of monitors not in the config")
    .option("--diff-only", "Exit 2 if drift is detected (useful for PR gates)")
    .option("--base-url <url>", "Override API base URL")
    .action(
      async (opts: {
        file: string;
        yes?: boolean;
        allowDelete?: boolean;
        diffOnly?: boolean;
        baseUrl?: string;
      }) => {
        try {
          const result = await runApply(opts);
          const { diff } = result;
          const hasDrift =
            diff.toCreate.length > 0 ||
            diff.toUpdate.length > 0 ||
            diff.toDelete.length > 0;

          if (opts.yes) {
            process.stdout.write(formatApplied(result) + "\n");
          } else {
            process.stdout.write(formatPlan(diff, Boolean(opts.allowDelete)) + "\n");
            if (!hasDrift) {
              process.stdout.write(pc.dim("No changes.\n"));
            } else {
              process.stdout.write(
                pc.dim('Run with --yes to apply') +
                  (diff.toDelete.length > 0 && !opts.allowDelete
                    ? pc.dim(" (and --allow-delete to enable deletions)")
                    : "") +
                  "\n",
              );
            }
          }

          if (opts.diffOnly && hasDrift) {
            process.exitCode = 2;
          }
        } catch (err) {
          process.stderr.write(pc.red("ERR ") + (err as Error).message + "\n");
          process.exitCode = 1;
        }
      },
    );
}
