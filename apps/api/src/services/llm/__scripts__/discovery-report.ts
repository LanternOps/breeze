#!/usr/bin/env tsx
/**
 * Tool-discovery report (#12421 W01): what ToolSearch queries users' words
 * produce, which tools surface, which are called and how each call ends.
 *
 * Usage:
 *   DATABASE_URL=… pnpm --filter @breeze/api ai:discovery-report -- --days 7 [--org <uuid>] [--out <file>] [--fingerprint <id>]
 *
 * Output goes to stdout and to apps/api/.ai-reports/ (gitignored):
 *   discovery-<YYYY-MM-DD>[-<org>].md       the report (--out must stay inside .ai-reports/)
 *   candidates/<YYYY-MM-DD>.json            empty-query candidates, written only with --org
 * Files under .ai-reports/ older than 30 days are deleted on every run.
 * Queries are printed only in per-org mode; cross-org mode prints tool names,
 * counts and a word list. Nothing from a report belongs in a commit, issue or PR.
 *
 * Invalid usage exits 2.
 */
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildDiscoveryReport,
  renderDiscoveryReportMarkdown,
  type DiscoveryReport,
  type DiscoveryReportInput,
} from '../../aiToolDiscoveryReport';

class UsageError extends Error {}

export const REPORT_RETENTION_DAYS = 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_REPORTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.ai-reports');

export interface DiscoveryCliArgs { days: number; orgId?: string; out?: string; fingerprint?: string }

/** The rows the loader supplies; the CLI adds mode, window, registry and the tier predicate. */
export type LoadedDiscoveryInput = Pick<
  DiscoveryReportInput,
  'searchEvents' | 'executions' | 'droppedResults' | 'turnRows' | 'userTurns' | 'sessions'
>;

export interface DiscoveryCliDeps {
  reportsDir: string;
  now: () => Date;
  io: { out: (text: string) => void; err: (text: string) => void };
  loadInput: (opts: { days: number; orgId?: string; since: Date; until: Date }) => Promise<LoadedDiscoveryInput>;
  build: (input: DiscoveryReportInput) => DiscoveryReport;
  registry: DiscoveryReportInput['registry'];
  isEscalatedCall: DiscoveryReportInput['isEscalatedCall'];
  actionInputKey?: DiscoveryReportInput['actionInputKey'];
}

export function parseArgs(argv: string[]): DiscoveryCliArgs {
  const known = new Set(['--days', '--org', '--out', '--fingerprint']);
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    // pnpm forwards the literal `--` of `pnpm … ai:discovery-report -- --days 7`.
    if (flag === '--') { i -= 1; continue; }
    if (!known.has(flag)) throw new UsageError(`Unknown option: ${flag}`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const rawDays = values.get('--days') ?? '7';
  const days = Number(rawDays);
  if (!/^\d+$/.test(rawDays) || !Number.isSafeInteger(days) || days < 1 || days > 365) {
    throw new UsageError('--days must be an integer from 1 to 365');
  }
  const orgId = values.get('--org');
  if (orgId !== undefined && !UUID_RE.test(orgId)) throw new UsageError('--org must be an organization UUID');
  return { days, orgId, out: values.get('--out'), fingerprint: values.get('--fingerprint') };
}

function resolveOut(out: string, reportsDir: string): string {
  const resolved = path.resolve(out);
  const rel = path.relative(path.resolve(reportsDir), resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new UsageError('--out must resolve inside apps/api/.ai-reports/');
  }
  return resolved;
}

function isNotFound(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Delete report and candidate files older than the cutoff. Per-org files hold
 * users' search queries, so a failure is reported (never swallowed); a file
 * that vanished meanwhile is not a failure.
 */
async function pruneOld(dir: string, cutoffMs: number, warn: (text: string) => void): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (!isNotFound(err)) warn(`prune: cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        await pruneOld(full, cutoffMs, warn);
      } else if ((await stat(full)).mtimeMs < cutoffMs) {
        await rm(full, { force: true });
      }
    } catch (err) {
      if (!isNotFound(err)) warn(`prune: cannot remove ${full}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Exported so the CLI is testable without a database or a process exit. */
export async function runCli(argv: string[], deps: DiscoveryCliDeps): Promise<number> {
  try {
    const args = parseArgs(argv);
    const now = deps.now();
    const date = now.toISOString().slice(0, 10);
    const outFile = args.out
      ? resolveOut(args.out, deps.reportsDir)
      : path.join(deps.reportsDir, `discovery-${date}${args.orgId ? `-${args.orgId}` : ''}.md`);
    const mode = args.orgId ? 'org' : 'cross-org';
    const since = new Date(now.getTime() - args.days * DAY_MS);

    const loaded = await deps.loadInput({ days: args.days, orgId: args.orgId, since, until: now });
    const report = deps.build({
      ...loaded,
      isEscalatedCall: deps.isEscalatedCall,
      actionInputKey: deps.actionInputKey,
      registry: deps.registry,
      window: { since, until: now },
      mode,
      fingerprint: args.fingerprint,
    });
    const markdown = renderDiscoveryReportMarkdown(report, mode);

    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, markdown);
    if (args.orgId) {
      const candidatesDir = path.join(deps.reportsDir, 'candidates');
      await mkdir(candidatesDir, { recursive: true });
      await writeFile(path.join(candidatesDir, `${date}.json`), JSON.stringify(report.candidates, null, 2) + '\n');
    }
    deps.io.out(markdown);
    // After the report is out: a prune problem is warned about, never fails the run.
    await pruneOld(deps.reportsDir, now.getTime() - REPORT_RETENTION_DAYS * DAY_MS, deps.io.err);
    return 0;
  } catch (error) {
    deps.io.err(error instanceof Error ? error.message : String(error));
    if (error instanceof UsageError) {
      deps.io.err('Usage: ai:discovery-report [--days N] [--org <uuid>] [--out <file inside .ai-reports/>] [--fingerprint <id>]');
      return 2;
    }
    return 1;
  }
}

async function defaultDeps(): Promise<DiscoveryCliDeps> {
  // Loaded lazily so importing this module (tests) pulls in no database or registry.
  const [{ loadDiscoveryInput }, { aiTools }, { isEscalatedCall }, { TOOL_ACTION_INPUT_KEYS }] = await Promise.all([
    import('./discovery-report.loader'),
    import('../../aiToolNames'),
    import('../../aiToolDiscoveryEscalation'),
    import('../../aiGuardrails'),
  ]);
  return {
    reportsDir: DEFAULT_REPORTS_DIR,
    now: () => new Date(),
    io: { out: (t) => console.log(t), err: (t) => console.error(t) },
    loadInput: loadDiscoveryInput,
    build: buildDiscoveryReport,
    registry: {
      allToolNames: [...aiTools.keys()],
      searchHints: new Map([...aiTools].map(([name, tool]) => [name, tool.searchHint])),
      alwaysLoad: new Set([...aiTools].filter(([, tool]) => tool.alwaysLoad === true).map(([name]) => name)),
    },
    isEscalatedCall,
    actionInputKey: (tool) => TOOL_ACTION_INPUT_KEYS[tool] ?? 'action',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    let code = 1;
    try {
      code = await runCli(process.argv.slice(2), await defaultDeps());
    } finally {
      try {
        const { closeDb } = await import('../../../db');
        await closeDb();
      } catch (error) {
        // Logged; the report's own exit code stands.
        console.error('closeDb failed:', error instanceof Error ? error.message : String(error));
      }
    }
    process.exit(code);
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
