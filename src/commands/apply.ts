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
 *                         config, and type changes (delete + create).
 *                         Without this flag both are shown in the plan but
 *                         never applied — prevents footgun.
 *   --diff-only           Exit 0 when no drift, exit 2 when drift detected.
 *                         Useful for PR gate: fail if config is out of sync.
 *   --json                Print the plan (or the apply result) as JSON on
 *                         stdout; progress lines go to stderr.
 *   --base-url <url>      Override API base URL.
 *
 * Type changes: the API cannot change a monitor's type in place (PATCH
 * ignores it). A changed `type` is a replacement: delete the old monitor,
 * create the new one. That is a delete, so it only runs with --allow-delete;
 * without it the change is reported as blocked and `--yes` exits 1.
 *
 * Exit codes: 0 ok · 1 error or blocked change under --yes · 2 drift with
 * --diff-only.
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

export interface ReplaceEntry {
  desired: MonitorDeclaration;
  live: LiveMonitor;
  /** Every changed field, `type` included. */
  changedFields: string[];
}

export interface ApplyDiff {
  toCreate: MonitorDeclaration[];
  toUpdate: Array<{ desired: MonitorDeclaration; live: LiveMonitor; changedFields: string[] }>;
  /**
   * Monitors whose `type` changed. The API cannot change a type in place, so
   * these are deleted and created again; that needs --allow-delete.
   */
  toReplace: ReplaceEntry[];
  toDelete: LiveMonitor[];
}

export interface ApplyOptions {
  file: string;
  yes?: boolean;
  allowDelete?: boolean;
  diffOnly?: boolean;
  json?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Where progress lines go. Defaults to stdout (stderr under --json). */
  log?: (line: string) => void;
}

export interface ApplyResult {
  diff: ApplyDiff;
  applied: boolean;
  created: number;
  updated: number;
  replaced: number;
  deleted: number;
  /** Type changes not applied because --allow-delete was not set. */
  blocked: number;
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
  const toReplace: ApplyDiff["toReplace"] = [];
  for (const m of desired.monitors) {
    const found = liveByExt.get(m.externalId);
    if (!found) {
      toCreate.push(m);
    } else {
      const changed = changedFields(m, found);
      if (changed.includes("type")) {
        toReplace.push({ desired: m, live: found, changedFields: changed });
      } else if (changed.length > 0) {
        toUpdate.push({ desired: m, live: found, changedFields: changed });
      }
    }
  }
  const toDelete = live.filter((m) => !desiredIds.has(m.externalId));
  return { toCreate, toUpdate, toReplace, toDelete };
}

export function hasDrift(diff: ApplyDiff): boolean {
  return (
    diff.toCreate.length > 0 ||
    diff.toUpdate.length > 0 ||
    diff.toReplace.length > 0 ||
    diff.toDelete.length > 0
  );
}

// ---------------------------------------------------------------------------
// Apply (write path)
// ---------------------------------------------------------------------------

function unwrapData(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as { data?: unknown }).data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return payload as Record<string, unknown>;
}

async function createMonitor(
  client: ReturnType<typeof createClient>,
  m: MonitorDeclaration,
): Promise<void> {
  const created = unwrapData(
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
    }),
  );
  // The API's create path applies its default timeout whatever the body
  // says; PATCH applies the value. Set a declared timeout right away so the
  // next plan is clean.
  const publicId = typeof created?.publicId === "string" ? created.publicId : undefined;
  if (m.timeout !== undefined && publicId && created?.timeout !== m.timeout) {
    await client.patch(`/api/v1/monitors/${publicId}`, { timeout: m.timeout });
  }
}

async function applyDiff(
  diff: ApplyDiff,
  opts: Pick<ApplyOptions, "allowDelete" | "baseUrl" | "fetchImpl">,
  log: (line: string) => void,
): Promise<{ created: number; updated: number; replaced: number; deleted: number; blocked: number }> {
  const client = createClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });
  let created = 0;
  let updated = 0;
  let replaced = 0;
  let deleted = 0;
  let blocked = 0;

  for (const m of diff.toCreate) {
    log(`  ${pc.green("+")} creating ${pc.bold(m.name)} (${m.externalId})…`);
    await createMonitor(client, m);
    created++;
    log(`    ${pc.green("✓")} created`);
  }

  for (const { desired, live, changedFields: fields } of diff.toUpdate) {
    log(`  ${pc.yellow("~")} updating ${pc.bold(live.name)} (${live.externalId}) [${fields.join(", ")}]…`);
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      body[f] = desired[f as keyof MonitorDeclaration];
    }
    await client.patch(`/api/v1/monitors/${live.publicId}`, body);
    updated++;
    log(`    ${pc.yellow("✓")} updated`);
  }

  for (const { desired, live } of diff.toReplace) {
    if (!opts.allowDelete) {
      blocked++;
      continue;
    }
    // The (owner, source, externalId) key is unique, so the old monitor has
    // to go before the new one can take its externalId.
    log(
      `  ${pc.magenta("±")} replacing ${pc.bold(live.name)} (${live.externalId}) [type ${live.type ?? "?"} → ${desired.type}]…`,
    );
    await client.delete(`/api/v1/monitors/${live.publicId}`);
    try {
      await createMonitor(client, desired);
    } catch (err) {
      throw new Error(
        `Replacing ${live.externalId}: the old ${live.type ?? ""} monitor was deleted but creating the ` +
          `${desired.type} monitor failed. Re-run apply to create it. Cause: ${(err as Error).message}`,
      );
    }
    replaced++;
    log(`    ${pc.magenta("✓")} replaced`);
  }

  if (blocked > 0) {
    log(
      pc.red(
        `\n  ${blocked} type change(s) blocked: the API cannot change a monitor's type in place.\n` +
          `  Changing it deletes the monitor (and its history) and creates a new one.\n` +
          `  Re-run with --allow-delete to replace them.`,
      ),
    );
  }

  if (diff.toDelete.length > 0 && !opts.allowDelete) {
    log(
      pc.yellow(
        `\n  ${diff.toDelete.length} monitor(s) would be deleted but --allow-delete was not set.\n` +
          `  Re-run with --allow-delete to remove them.`,
      ),
    );
  } else {
    for (const m of diff.toDelete) {
      log(`  ${pc.red("-")} deleting ${pc.bold(m.name)} (${m.externalId})…`);
      await client.delete(`/api/v1/monitors/${m.publicId}`);
      deleted++;
      log(`    ${pc.red("✓")} deleted`);
    }
  }

  return { created, updated, replaced, deleted, blocked };
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

/** Page size for listing: the API's maximum (`limit` is clamped to 100). */
export const LIST_PAGE_SIZE = 100;
/** Safety stop so a misbehaving server cannot loop forever (100k monitors). */
const MAX_LIST_PAGES = 1000;

interface ListPagination {
  page?: number;
  totalPages?: number;
  hasNextPage?: boolean;
}

/**
 * Read every CLI-managed monitor. GET /api/v1/monitors is paginated
 * (`page`, `limit` ≤ 100, default 20); reading only the first page would
 * make apply re-create every managed monitor past it.
 */
export async function listManagedMonitors(client: ReturnType<typeof createClient>): Promise<LiveMonitor[]> {
  const all: LiveMonitor[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const payload = await client
      .get<unknown>(`/api/v1/monitors?managedBySource=cli&limit=${LIST_PAGE_SIZE}&page=${page}`)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) return [];
        throw err;
      });
    const items = asLiveMonitors(payload);
    all.push(...items);

    const pagination =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? ((payload as { pagination?: ListPagination }).pagination ?? undefined)
        : undefined;
    // A bare array (no pagination block) is the whole list.
    if (!pagination) return all;
    const more =
      typeof pagination.hasNextPage === "boolean"
        ? pagination.hasNextPage
        : typeof pagination.totalPages === "number"
          ? page < pagination.totalPages
          : items.length >= LIST_PAGE_SIZE;
    if (!more || items.length === 0) return all;
  }
  throw new Error(`Listing monitors did not finish after ${MAX_LIST_PAGES} pages`);
}

export async function runApply(opts: ApplyOptions): Promise<ApplyResult> {
  const desired = loadConfig(opts.file);
  const client = createClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  const live = await listManagedMonitors(client);
  const diff = computeDiff(desired, live);

  if (!opts.yes) {
    return {
      diff,
      applied: false,
      created: 0,
      updated: 0,
      replaced: 0,
      deleted: 0,
      blocked: opts.allowDelete ? 0 : diff.toReplace.length,
    };
  }

  const log =
    opts.log ?? ((line: string) => (opts.json ? process.stderr : process.stdout).write(line + "\n"));
  const counts = await applyDiff(diff, opts, log);
  return { diff, applied: true, ...counts };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatPlan(diff: ApplyDiff, allowDelete: boolean): string {
  const lines: string[] = [];
  lines.push(pc.bold("Plan:"));
  lines.push(`  ${pc.green("+")} create  ${diff.toCreate.length}`);
  lines.push(`  ${pc.yellow("~")} update  ${diff.toUpdate.length}`);
  const blockedNote =
    !allowDelete && diff.toReplace.length > 0 ? pc.dim(" (blocked: requires --allow-delete)") : "";
  lines.push(`  ${pc.magenta("±")} replace ${diff.toReplace.length}${blockedNote}`);
  const deleteNote = !allowDelete && diff.toDelete.length > 0 ? pc.dim(" (requires --allow-delete)") : "";
  lines.push(`  ${pc.red("-")} delete  ${diff.toDelete.length}${deleteNote}`);
  for (const m of diff.toCreate) {
    lines.push(`    ${pc.green("+")} ${m.externalId} (${m.name})`);
  }
  for (const u of diff.toUpdate) {
    lines.push(`    ${pc.yellow("~")} ${u.desired.externalId} — changed: ${u.changedFields.join(", ")}`);
  }
  for (const r of diff.toReplace) {
    const mark = allowDelete ? pc.magenta("±") : pc.red("!");
    const why = allowDelete
      ? "delete + create"
      : "blocked: the API cannot change a monitor's type; replacing it deletes the monitor and its history";
    lines.push(
      `    ${mark} ${r.desired.externalId} — type ${r.live.type ?? "?"} → ${r.desired.type} (${why})`,
    );
  }
  for (const m of diff.toDelete) {
    lines.push(`    ${pc.red("-")} ${m.externalId} (${m.name})`);
  }
  return lines.join("\n");
}

/** Machine-readable plan for CI (`--json`). Stable keys; no colour codes. */
export function planToJson(diff: ApplyDiff, allowDelete: boolean): Record<string, unknown> {
  return {
    hasDrift: hasDrift(diff),
    allowDelete,
    create: diff.toCreate.map((m) => ({ externalId: m.externalId, name: m.name, type: m.type ?? "http" })),
    update: diff.toUpdate.map((u) => ({
      externalId: u.desired.externalId,
      publicId: u.live.publicId,
      changedFields: u.changedFields,
    })),
    replace: diff.toReplace.map((r) => ({
      externalId: r.desired.externalId,
      publicId: r.live.publicId,
      fromType: r.live.type ?? null,
      toType: r.desired.type,
      changedFields: r.changedFields,
      blocked: !allowDelete,
    })),
    delete: diff.toDelete.map((m) => ({
      externalId: m.externalId,
      publicId: m.publicId,
      name: m.name,
      blocked: !allowDelete,
    })),
  };
}

export function formatApplied(result: ApplyResult): string {
  const { created, updated, replaced, deleted, blocked } = result;
  const parts: string[] = [];
  if (created > 0) parts.push(pc.green(`${created} created`));
  if (updated > 0) parts.push(pc.yellow(`${updated} updated`));
  if (replaced > 0) parts.push(pc.magenta(`${replaced} replaced`));
  if (deleted > 0) parts.push(pc.red(`${deleted} deleted`));
  const blockedNote = blocked > 0 ? pc.red(` (${blocked} type change(s) blocked; needs --allow-delete)`) : "";
  if (parts.length === 0) return (blocked > 0 ? pc.bold("Applied: nothing") : pc.dim("No changes.")) + blockedNote;
  return pc.bold("Applied: ") + parts.join(", ") + blockedNote;
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
    .option("--allow-delete", "Allow deletions: monitors not in the config, and type changes (delete + create)")
    .option("--diff-only", "Exit 2 if drift is detected (useful for PR gates)")
    .option("--json", "Print the plan (or the apply result) as JSON on stdout")
    .option("--base-url <url>", "Override API base URL")
    .action(
      async (opts: {
        file: string;
        yes?: boolean;
        allowDelete?: boolean;
        diffOnly?: boolean;
        json?: boolean;
        baseUrl?: string;
      }) => {
        try {
          const result = await runApply(opts);
          const { diff } = result;
          const drift = hasDrift(diff);
          const allowDelete = Boolean(opts.allowDelete);

          if (opts.json) {
            const out = opts.yes
              ? {
                  applied: true,
                  created: result.created,
                  updated: result.updated,
                  replaced: result.replaced,
                  deleted: result.deleted,
                  blocked: result.blocked,
                  plan: planToJson(diff, allowDelete),
                }
              : { applied: false, ...planToJson(diff, allowDelete) };
            process.stdout.write(JSON.stringify(out, null, 2) + "\n");
          } else if (opts.yes) {
            process.stdout.write(formatApplied(result) + "\n");
          } else {
            process.stdout.write(formatPlan(diff, allowDelete) + "\n");
            if (!drift) {
              process.stdout.write(pc.dim("No changes.\n"));
            } else {
              const needsAllowDelete =
                !allowDelete && (diff.toDelete.length > 0 || diff.toReplace.length > 0);
              process.stdout.write(
                pc.dim("Run with --yes to apply") +
                  (needsAllowDelete ? pc.dim(" (and --allow-delete to enable deletions and type changes)") : "") +
                  "\n",
              );
            }
          }

          if (opts.yes && result.blocked > 0) {
            process.exitCode = 1;
          } else if (opts.diffOnly && drift) {
            process.exitCode = 2;
          }
        } catch (err) {
          process.stderr.write(pc.red("ERR ") + (err as Error).message + "\n");
          process.exitCode = 1;
        }
      },
    );
}
