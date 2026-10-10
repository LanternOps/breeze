import type { JobsOptions, Queue } from 'bullmq';

/**
 * Build a BullMQ custom job id from its parts, joined with '-'.
 *
 * bullmq 5.x throws `Custom Id cannot contain :` from `queue.add` for a custom
 * jobId containing ':' unless it happens to split into exactly three parts (a
 * legacy-repeatable carve-out bullmq marks for removal), and `Custom Id cannot
 * be integers` for an all-digit id. Most enqueue sites catch and log, so a bad
 * id silently disables the feature instead of failing loudly. Any ':' inside a
 * part (an ISO timestamp, a free-text key) is replaced with '-', so no input can
 * produce an id bullmq rejects. Deterministic: use the same call for the
 * matching `getJob(id)` / `remove(id)` lookup. The no-colon rule for every id in
 * apps/api/src is enforced by `bullmqUtils.noColonJobIds.test.ts`.
 */
export function bullmqJobId(...parts: Array<string | number>): string {
  const id = parts.map((part) => String(part).replace(/:/g, '-')).join('-');
  if (id.length === 0) {
    throw new Error('bullmqJobId: at least one non-empty part is required');
  }
  if (`${Number.parseInt(id, 10)}` === id) {
    throw new Error(`bullmqJobId: "${id}" is an integer, which BullMQ rejects as a custom id`);
  }
  return id;
}

/**
 * BullMQ job states that indicate the job is already queued for processing
 * and should be reused rather than creating a duplicate.
 */
export function isReusableState(state: string): boolean {
  return (
    state === 'active'
    || state === 'waiting'
    || state === 'delayed'
    || state === 'waiting-children'
    || state === 'prioritized'
  );
}

/**
 * Enqueue under a fixed `jobId`, collapsing a genuine in-flight duplicate but
 * NOT a stale one.
 *
 * A bare `queue.add(name, payload, { jobId })` looks like it does this, and for
 * a live job it does. But BullMQ's jobId dedup keys on "a record with this id
 * exists", not "a job with this id is pending — so once a job has FAILED (and
 * `removeOnFail: { count: N }` deliberately keeps the last N failures around for
 * inspection), every later `add` under that id is silently discarded. `add`
 * still returns the stale job, so the caller gets a plausible job id back and
 * nothing runs. For a retry path — an admin clicking again, a sweeper trying to
 * finish a torn operation — that is a permanent wedge with no error anywhere.
 *
 * This is the shape `jobs/alertWorker.ts` already uses for on-demand device
 * evaluation, lifted out so the enqueue helpers that share the same hazard
 * (`enqueueOrgMerge`, `enqueueTenantErasure`) share one implementation of it.
 *
 * Reusable states (see `isReusableState`) are returned as-is: a merge or an
 * erasure that is genuinely running must never be restarted underneath itself.
 * Every other state — `failed`, `completed`, `unknown` — is treated as a spent
 * record, removed, and re-added fresh. Callers that must not re-run a completed
 * operation are expected to refuse it on the merits at the top of the worker
 * (both of this helper's callers do: their engines re-validate the org's state
 * inside their own transaction), rather than relying on a queue-record side
 * effect that expires after N jobs.
 */
export async function enqueueOrReplaceStale<T extends object>(
  queue: Queue,
  jobName: string,
  jobId: string,
  payload: T,
  options: Omit<JobsOptions, 'jobId'>,
  logPrefix: string,
): Promise<{ id: string }> {
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return { id: String(existing.id ?? jobId) };
    }
    await existing.remove().catch((error) => {
      console.error(`${logPrefix} Failed to remove stale job ${jobId} (state '${state}'):`, error);
    });
  }

  const job = await queue.add(jobName, payload, { ...options, jobId });
  return { id: job.id ?? jobId };
}
