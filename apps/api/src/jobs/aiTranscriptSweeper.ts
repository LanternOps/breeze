/**
 * AI SDK transcript sweeper (#9050; follow-up to the #8852 W03 retention job).
 *
 * `aiToolOutputRetention` clears `ai_sessions.sdk_session_id` and deletes the
 * old transcript with the SDK's `deleteSession`, but that only reaches the
 * disk of the process the retention job runs in. Under a `BREEZE_ROLE` split
 * the job runs on a worker while the transcripts
 * (`$CLAUDE_CONFIG_DIR|$HOME/.claude/projects/<project>/<id>.jsonl`) were
 * written by API containers, so they stayed behind, unreferenced, until the
 * container was replaced.
 *
 * This job closes that gap from the other side: every process that owns a
 * transcript directory lists it nightly and deletes each transcript no
 * `ai_sessions` row references any more.
 *
 * PLACEMENT. The SDK query loop (and so every transcript) lives in the API
 * role: registered `socket-owner`, so it runs on `BREEZE_ROLE=api` and `all`
 * and never on a `worker`, which has no transcripts. In the default single
 * process (`all`) it is also redundant-but-harmless next to the retention job.
 *
 * PER-HOST QUEUE. A transcript directory is local to a container, so each
 * container must run the sweep itself. A single shared BullMQ queue would hand
 * the nightly job to ONE container only, so the queue name carries the host
 * name. The cost is a dormant repeat schedule in Redis for each replaced
 * container (a hostname that no longer exists is never consumed); it is tiny
 * and bounded by the container churn.
 *
 * SAFETY. A transcript is deleted only when ALL hold:
 *   - its file name is a UUID `.jsonl` directly inside a project directory;
 *   - its mtime is older than the grace period (default 24 h), which covers a
 *     freshly started session whose id has not been written to `ai_sessions`
 *     yet and any transcript still being appended to;
 *   - no `ai_sessions.sdk_session_id` equals its id. A failed lookup aborts the
 *     run before anything in that batch is deleted (fail closed).
 * The job runs only in production by default (see `sweeperEnabled`) because the
 * default projects dir is shared with the Claude Code CLI on a dev machine.
 * Deletion goes through the SDK's own `deleteSession` (the transcript plus its
 * subagent directory). Idempotent: a second run finds nothing left to do.
 */
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Job, Queue, Worker } from 'bullmq';
import { inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { aiSessions } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureMessage } from '../services/sentry';
import { deleteSdkTranscript, type TranscriptDeleter } from './aiToolOutputRetention';
import { cronFromEnv } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
import { parsePositiveIntEnv } from './retentionBatch';

export type { TranscriptDeleter };

const LOG = '[AiTranscriptSweeper]';
const QUEUE_BASE = 'ai-transcript-sweeper';
const JOB_NAME = 'ai-transcript-sweeper';
const REPEAT_JOB_ID = 'ai-transcript-sweeper';
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_GRACE_HOURS = 24;
const DEFAULT_LOOKUP_BATCH = 500;
/** SDK session ids are UUIDs; anything else in the directory is not ours to delete. */
const TRANSCRIPT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface TranscriptSweepOptions {
  projectsDir: string;
  graceMs: number;
  now?: Date;
  /** Ids per `ai_sessions` lookup. */
  batchSize?: number;
  deleteTranscript?: TranscriptDeleter;
}

export interface TranscriptSweepSummary {
  scanned: number;
  withinGrace: number;
  referenced: number;
  orphans: number;
  deleted: number;
  notFound: number;
  failed: number;
}

/** Where the SDK keeps transcripts for this process. */
export function resolveProjectsDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

async function listTranscripts(projectsDir: string): Promise<Array<{ id: string; mtimeMs: number }>> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ id: string; mtimeMs: number }> = [];
  for (const project of projects) {
    let files: string[];
    try {
      files = await readdir(path.join(projectsDir, project));
    } catch (err) {
      // A stray file in projects/ (ENOTDIR) or a directory deleted under us.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR' || code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files) {
      const match = TRANSCRIPT_FILE.exec(file);
      if (!match) continue;
      try {
        const s = await stat(path.join(projectsDir, project, file));
        if (s.isFile()) out.push({ id: match[1]!, mtimeMs: s.mtimeMs });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
  return out;
}

async function referencedIds(ids: string[]): Promise<Set<string>> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db
      .select({ sdkSessionId: aiSessions.sdkSessionId })
      .from(aiSessions)
      .where(inArray(aiSessions.sdkSessionId, ids)),
    'aiTranscriptSweeper.lookup',
  ));
  return new Set(rows.map((r) => r.sdkSessionId).filter((v): v is string => typeof v === 'string'));
}

export async function sweepOrphanTranscripts(opts: TranscriptSweepOptions): Promise<TranscriptSweepSummary> {
  const now = (opts.now ?? new Date()).getTime();
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_LOOKUP_BATCH);
  const deleteTranscript = opts.deleteTranscript ?? deleteSdkTranscript;
  const summary: TranscriptSweepSummary = {
    scanned: 0, withinGrace: 0, referenced: 0, orphans: 0, deleted: 0, notFound: 0, failed: 0,
  };

  const files = await listTranscripts(opts.projectsDir);
  summary.scanned = files.length;
  const candidates: string[] = [];
  for (const f of files) {
    if (now - f.mtimeMs < opts.graceMs) summary.withinGrace += 1;
    else candidates.push(f.id);
  }

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    // Throws on a DB failure: nothing in this or any later batch is deleted.
    const live = await referencedIds(batch);
    for (const id of batch) {
      if (live.has(id)) { summary.referenced += 1; continue; }
      summary.orphans += 1;
      const outcome = await deleteTranscript(id).catch((err: unknown) => {
        console.warn(`${LOG} Transcript deleter threw for ${id}:`, err);
        return 'failed' as const;
      });
      if (outcome === 'deleted') summary.deleted += 1;
      // The file was listed moments ago, so "not found" means the SDK is looking
      // in a different directory than we are: a failure, never a clean outcome.
      else if (outcome === 'not_found') { summary.notFound += 1; summary.failed += 1; }
      else summary.failed += 1;
    }
  }
  return summary;
}

// --------------------------------------------------------------------------
// BullMQ wiring
// --------------------------------------------------------------------------

type SweepJobData = Record<string, never>;

const GRACE_HOURS = parsePositiveIntEnv(LOG, 'AI_TRANSCRIPT_SWEEPER_GRACE_HOURS', DEFAULT_GRACE_HOURS);

/** BullMQ queue names allow `[A-Za-z0-9_-]` here (no `:`); host names can carry dots. */
function queueNameForHost(host: string = os.hostname()): string {
  const safe = host.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100) || 'host';
  return `${QUEUE_BASE}-${safe}`;
}
const QUEUE_NAME = queueNameForHost();

let queue: Queue<SweepJobData> | null = null;
let worker: Worker<SweepJobData> | null = null;

function getQueue(): Queue<SweepJobData> {
  if (!queue) queue = new Queue<SweepJobData>(QUEUE_NAME, { connection: getBullMQConnection() });
  return queue;
}

/**
 * The projects dir defaults to `~/.claude/projects`, the same place the Claude
 * Code CLI keeps ITS UUID-named transcripts. On a developer machine or a
 * self-hoster running the API as the CLI's OS user, sweeping it would delete
 * the user's own CLI history. So the sweep defaults ON only in production
 * (containers with a private HOME); `AI_TRANSCRIPT_SWEEPER_ENABLED` overrides.
 */
export function sweeperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.AI_TRANSCRIPT_SWEEPER_ENABLED?.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return env.NODE_ENV === 'production';
}

export async function runAiTranscriptSweep(): Promise<TranscriptSweepSummary | null> {
  if (!sweeperEnabled()) {
    console.log(`${LOG} Disabled (NODE_ENV is not production; set AI_TRANSCRIPT_SWEEPER_ENABLED=true to run)`);
    return null;
  }
  const summary = await sweepOrphanTranscripts({
    projectsDir: resolveProjectsDir(),
    graceMs: GRACE_HOURS * HOUR_MS,
  });
  console.log(
    `${LOG} scanned=${summary.scanned} withinGrace=${summary.withinGrace} referenced=${summary.referenced} ` +
    `orphans=${summary.orphans} deleted=${summary.deleted} notFound=${summary.notFound} failed=${summary.failed}`,
  );
  if (summary.failed > 0) {
    try {
      captureMessage(
        `${LOG} Could not delete ${summary.failed} of ${summary.orphans} orphaned SDK transcript(s) (notFound=${summary.notFound})`,
        { eventCode: 'ai_transcript_sweep_incomplete' },
      );
    } catch (err) {
      console.warn(`${LOG} Failed to report the incomplete sweep to Sentry:`, err);
    }
  }
  return summary;
}

export function createAiTranscriptSweeperWorker(): Worker<SweepJobData> {
  return new Worker<SweepJobData>(
    QUEUE_NAME,
    // Not wrapped in a DB context: each lookup opens its own short system one.
    async (_job: Job<SweepJobData>) => runAiTranscriptSweep(),
    { connection: getBullMQConnection(), concurrency: 1 },
  );
}

export async function initializeAiTranscriptSweeper(): Promise<void> {
  worker = createAiTranscriptSweeperWorker();
  attachWorkerObservability(worker, 'aiTranscriptSweeper');
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(JOB_NAME, {}, {
    jobId: REPEAT_JOB_ID,
    repeat: { pattern: cronFromEnv('AI_TRANSCRIPT_SWEEPER_CRON', 'ai-transcript-sweeper') },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  });
  console.log(`${LOG} Transcript sweeper initialized (grace ${GRACE_HOURS}h, dir ${resolveProjectsDir()})`);
}

export async function shutdownAiTranscriptSweeper(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}

export const __testOnly = { QUEUE_NAME, queueNameForHost };
