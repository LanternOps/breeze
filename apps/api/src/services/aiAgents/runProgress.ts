/**
 * Run progress telemetry (spec §5.8, W03).
 *
 * TWO SINKS, ON PURPOSE. `publishEvent` reaches the events WebSocket (chat run
 * cards, dashboards); the Redis ring is what the RUN DETAIL PAGE can actually
 * read, because that page POLLS `GET /ai/agents/runs/:runId` every 5s
 * (DETAIL_POLL_INTERVAL_MS) and subscribes to no stream. Neither is durable
 * run state: the durable per-step transcript is `ai_run_workspaces.steps`
 * (W04). This is a one-hour, fifty-entry window on a live run — losing it
 * costs a spinner, never a record.
 */
import { publishEvent } from '../eventBus';
import { getRedis } from '../redis';

export interface RunProgressContext {
  orgId: string;
  runId: string;
}

export interface RunProgressEntry {
  step: string;
  label: string;
  ordinal: number;
  at: string;
}

export const RUN_PROGRESS_MAX_ENTRIES = 50;
export const RUN_PROGRESS_TTL_SECONDS = 3600;

/** Ring key. Carries the run id only — no org id, matching the artifact-key rule. */
export function runProgressKey(runId: string): string {
  return `breeze:ai:run-progress:${runId}`;
}

/**
 * Per-run ordinal counter. Process-local: a run executes inside ONE worker
 * process for its whole life (the run lease), so a single counter is correct.
 * Bounded by the same cap as the ring so a long-lived worker cannot grow it.
 */
const ordinals = new Map<string, number>();

function nextOrdinal(runId: string): number {
  const next = (ordinals.get(runId) ?? 0) + 1;
  ordinals.set(runId, next);
  if (ordinals.size > 10_000) {
    const oldest = ordinals.keys().next();
    if (!oldest.done) ordinals.delete(oldest.value);
  }
  return next;
}

/** Tests only — resets the module-level ordinal table. */
export function __resetRunProgressOrdinals(): void {
  ordinals.clear();
}

/**
 * Record one progress beat. NEVER throws: an observability write must not be
 * able to turn a finished run into a failed one (same rule as runLoop's
 * `safePublish`).
 */
export async function emitRunProgress(
  ctx: RunProgressContext,
  step: string,
  label: string,
): Promise<void> {
  const entry: RunProgressEntry = {
    step,
    label,
    ordinal: nextOrdinal(ctx.runId),
    at: new Date().toISOString(),
  };

  try {
    await publishEvent(
      'ai.agent.run.progress',
      ctx.orgId,
      { runId: ctx.runId, step: entry.step, label: entry.label, ordinal: entry.ordinal },
      'ai-agent-runner',
    );
  } catch (error) {
    console.error('[aiRunProgress] failed to publish progress event', { runId: ctx.runId, error });
  }

  try {
    const redis = getRedis();
    if (!redis) return;
    const key = runProgressKey(ctx.runId);
    await redis.rpush(key, JSON.stringify(entry));
    await redis.ltrim(key, -RUN_PROGRESS_MAX_ENTRIES, -1);
    await redis.expire(key, RUN_PROGRESS_TTL_SECONDS);
  } catch (error) {
    console.error('[aiRunProgress] failed to mirror progress entry', { runId: ctx.runId, error });
  }
}

/**
 * Read back the ring for the run detail DTO. Returns `[]` when Redis is
 * unavailable or the window has expired — an empty step list, never an error:
 * the page's other sections must still render.
 */
export async function readRunProgress(runId: string): Promise<RunProgressEntry[]> {
  try {
    const redis = getRedis();
    if (!redis) return [];
    const raw = await redis.lrange(runProgressKey(runId), 0, -1);
    const entries: RunProgressEntry[] = [];
    for (const item of raw) {
      try {
        const parsed = JSON.parse(item) as RunProgressEntry;
        if (typeof parsed.step === 'string' && typeof parsed.label === 'string' && typeof parsed.ordinal === 'number') {
          entries.push(parsed);
        }
      } catch {
        // A malformed ring entry is skipped, not fatal.
      }
    }
    return entries;
  } catch (error) {
    console.error('[aiRunProgress] failed to read progress ring', { runId, error });
    return [];
  }
}
