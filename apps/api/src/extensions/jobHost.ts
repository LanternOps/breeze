/**
 * BullMQ job host for runtime extensions.
 *
 * One `breeze-extension-jobs` Queue + Worker serves every active extension's
 * cron jobs. Repeatable schedules use stable jobIds (`extension-<name>-<job>`)
 * and BullMQ cron patterns, so scheduling is multi-replica-dedup'd exactly like
 * the audit-retention worker.
 *
 * The processor is deliberately defensive:
 *   • it resolves the CURRENT active registry snapshot per run (never a stale
 *     closure), so a redeployed handler is picked up;
 *   • it re-checks `installed_extensions.enabled` (via the state store, which
 *     wraps the read in system DB scope) and SKIPS a claimed job for a disabled
 *     extension — it does NOT cancel an already-running handler, it just refuses
 *     to start a new one;
 *   • it lets handler errors PROPAGATE to BullMQ's retry machinery (never
 *     swallows them) while still recording an outcome metric.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { getBullMQConnection } from '../services/redis';
import {
  extensionContributionRegistry,
  type ExtensionContributionRegistry,
  type StagedExtensionContributions,
} from './contributionRegistry';
import { createExtensionStateStore, type ExtensionStateStore } from './stateStore';
import { recordExtensionJob } from './metrics';

export const EXTENSION_JOBS_QUEUE = 'breeze-extension-jobs';
const WORKER_CONCURRENCY = 4;
const REMOVE_ON_COMPLETE = { count: 50 };
const REMOVE_ON_FAIL = { count: 100 };

/** Stable, collision-free repeatable id for one (extension, job) pair. */
export function extensionJobId(extension: string, job: string): string {
  return `extension-${extension}-${job}`;
}

const EXTENSION_JOB_ID_PREFIX = 'extension-';

/**
 * Recover the extension name from a repeatable jobId by matching it against
 * names the caller RECOGNIZES, returning null when none match.
 *
 * `extension-<name>-<job>` cannot be split naively: BOTH the extension name and
 * the job name may contain hyphens, so `extension-acme-billing-nightly-sweep`
 * has no positional answer. Nor can the job name BullMQ reports be subtracted
 * from the end — a repeatable whose job was renamed keeps its original id, so
 * the id no longer ends with the current name.
 *
 * What is reliable is the set of names this replica knows. Every hyphen boundary
 * after the prefix is a candidate extension name; the first one `isKnown`
 * accepts is the owner. Candidates are tried shortest-first and the final
 * segment is never a candidate on its own, because the job part is non-empty.
 * A jobId whose owner is not recognized yields null — the caller must treat that
 * as "not this replica's to reason about", not as "stale".
 */
export function resolveRepeatableExtensionName(
  id: string,
  isKnown: (name: string) => boolean,
): string | null {
  if (!id.startsWith(EXTENSION_JOB_ID_PREFIX)) return null;
  const rest = id.slice(EXTENSION_JOB_ID_PREFIX.length);
  for (let i = rest.indexOf('-'); i > 0; i = rest.indexOf('-', i + 1)) {
    const candidate = rest.slice(0, i);
    if (isKnown(candidate)) return candidate;
  }
  return null;
}

/** The payload every extension job carries so the processor can route it. */
export interface ExtensionJobData {
  extension: string;
  job: string;
}

/** The registry surface the host needs (injectable for tests). */
export type JobHostRegistry = Pick<ExtensionContributionRegistry, 'get' | 'listActive'>;

/** The state-store surface the host needs (injectable for tests). */
export type JobHostStore = Pick<ExtensionStateStore, 'isEnabled'>;

/** The BullMQ queue surface `sync` needs — the real Queue satisfies it. */
export interface JobHostQueue {
  // `id`/`pattern` are widened to include `undefined`/`null` because that is
  // what BullMQ's `RepeatableJob` actually carries; narrowing them here would
  // make the real Queue unassignable to this port.
  getRepeatableJobs(): Promise<
    Array<{ key: string; name: string; id?: string | null; pattern?: string | null }>
  >;
  removeRepeatableByKey(key: string): Promise<boolean>;
  add(name: string, data: unknown, opts: unknown): Promise<unknown>;
}

export interface ExtensionJobHostDeps {
  registry: JobHostRegistry;
  store: JobHostStore;
  /** Metrics sink; defaults to the bound extension recorder. */
  recordJob?: (
    extension: string,
    job: string,
    outcome: 'success' | 'failure',
    durationSeconds: number,
  ) => void;
}

export class ExtensionJobHost {
  private readonly registry: JobHostRegistry;
  private readonly store: JobHostStore;
  private readonly recordJob: NonNullable<ExtensionJobHostDeps['recordJob']>;

  constructor(deps: ExtensionJobHostDeps) {
    this.registry = deps.registry;
    this.store = deps.store;
    this.recordJob = deps.recordJob ?? recordExtensionJob;
  }

  /**
   * Process one claimed BullMQ job. Resolves the current snapshot + handler,
   * skips a disabled extension without running the handler, and otherwise runs
   * it — recording the outcome and re-throwing any error to BullMQ.
   */
  async process(job: Job): Promise<void> {
    const data = job.data as Partial<ExtensionJobData> | undefined;
    const extension = data?.extension;
    const jobName = data?.job;
    if (!extension || !jobName) return;

    const snapshot = this.registry.get(extension);
    const definition = snapshot?.jobs.get(jobName);
    if (!definition) return; // extension withdrawn or job removed — nothing to run.

    // Cross-replica enable check. A disabled extension SKIPS: no handler call.
    if (!(await this.store.isEnabled(extension))) return;

    const startedAt = Date.now();
    try {
      await definition.handler();
      this.recordJob(extension, jobName, 'success', (Date.now() - startedAt) / 1000);
    } catch (error) {
      // Record the failure, then let it reach BullMQ retry handling untouched.
      this.recordJob(extension, jobName, 'failure', (Date.now() - startedAt) / 1000);
      throw error;
    }
  }

  /**
   * Reconcile the queue's repeatable schedules against the desired set derived
   * from the active extensions' declared jobs: remove OUR stale repeatables,
   * then (re)add every currently-desired one. Non-extension repeatables (other
   * workers sharing Redis) are never touched.
   *
   * Staleness is decided on the FULL repeatable identity `(name, id, pattern)`,
   * not on the jobId alone. BullMQ keys a repeatable by its whole option set
   * (`name:jobId:endDate:tz:pattern`), so a cron-pattern change or a job rename
   * produces a NEW key while the old entry keeps firing — matching on jobId
   * alone would leave the old schedule in place and `add` a second one, so the
   * job would run on both patterns forever, accumulating one more schedule per
   * change. Same rationale as `jobs/auditRetention.ts`.
   *
   * The desired set is `listActive()` INTERSECTED with the durable `enabled`
   * flag. `listActive()` alone reflects only this replica's in-memory snapshot,
   * so a replica that never saw the disable would re-add the disabled
   * extension's repeatables on its next sync — permanently, since nothing else
   * converges it. Reading the flag makes any replica's sync produce the same
   * desired set.
   *
   * REMOVAL is additionally scoped to extensions THIS replica knows about, so a
   * sync here can never delete a schedule owned by an extension that only
   * another replica activated. See the removal loop for why.
   */
  async sync(
    queue: JobHostQueue,
    active: readonly StagedExtensionContributions[] = this.registry.listActive(),
  ): Promise<void> {
    const desired = new Map<string, { extension: string; job: string; cron: string }>();
    for (const snapshot of active) {
      if (!(await this.store.isEnabled(snapshot.name))) continue;
      for (const definition of snapshot.jobs.values()) {
        const id = extensionJobId(snapshot.name, definition.name);
        desired.set(id, { extension: snapshot.name, job: definition.name, cron: definition.cron });
      }
    }

    const existing = await queue.getRepeatableJobs();
    for (const entry of existing) {
      // Only manage repeatables we own; leave every other worker's alone.
      if (!entry.id || !entry.id.startsWith(EXTENSION_JOB_ID_PREFIX)) continue;

      // ...and, among our own, only ones THIS replica can account for. The
      // desired set is derived from this replica's registry, so an extension
      // absent from the registry entirely (never activated here — e.g. it is
      // optional and its `acquire` hit a transient network failure on this
      // replica while another replica activated it fine) would otherwise be
      // read as "not desired" and have its LIVE schedule deleted. Nothing
      // re-creates it until the owning replica restarts, so the extension's
      // cron would stop firing fleet-wide even though it is enabled in the DB.
      //
      // Leaving a foreign repeatable in place is inert by comparison: if the
      // extension really is gone, `process()` returns early because it cannot
      // resolve the definition. Present-but-DISABLED is a different case and
      // still gets removed — it IS in the registry, so this check passes and
      // the desired-set intersection with `enabled` drops it (81819167e).
      const owner = resolveRepeatableExtensionName(
        entry.id,
        (name) => this.registry.get(name) !== undefined,
      );
      if (owner === null) continue;

      const want = desired.get(entry.id);
      const matchesDesiredIdentity = want !== undefined
        && entry.name === want.job
        && entry.pattern === want.cron;
      if (!matchesDesiredIdentity) {
        await queue.removeRepeatableByKey(entry.key);
      }
    }

    for (const [id, want] of desired) {
      await queue.add(
        want.job,
        { extension: want.extension, job: want.job } satisfies ExtensionJobData,
        {
          jobId: id,
          repeat: { pattern: want.cron },
          removeOnComplete: REMOVE_ON_COMPLETE,
          removeOnFail: REMOVE_ON_FAIL,
        },
      );
    }
  }
}

// ── Production singletons ────────────────────────────────────────────────────

let queue: Queue | null = null;
let worker: Worker | null = null;

export function getExtensionJobsQueue(): Queue {
  if (!queue) {
    queue = new Queue(EXTENSION_JOBS_QUEUE, { connection: getBullMQConnection() });
  }
  return queue;
}

/**
 * Create the worker + reconcile schedules against the live registry. Called
 * once at startup after `reconcileExtensions`. The processor resolves the
 * CURRENT registry snapshot on every run, so activations/withdrawals after boot
 * are honored without recreating the worker.
 */
export async function initializeExtensionJobHost(
  registry: ExtensionContributionRegistry,
  store: ExtensionStateStore,
): Promise<void> {
  const host = new ExtensionJobHost({ registry, store });
  worker = new Worker(
    EXTENSION_JOBS_QUEUE,
    (job: Job) => host.process(job),
    { connection: getBullMQConnection(), concurrency: WORKER_CONCURRENCY },
  );
  await host.sync(getExtensionJobsQueue());
}

/**
 * Reconcile repeatable schedules against the CURRENT registry, on demand.
 *
 * `initializeExtensionJobHost` only syncs at boot, so an extension disabled
 * through the admin API would keep its BullMQ repeatable entries until the next
 * restart — the processor skips a disabled extension's ticks, but the schedules
 * themselves linger. The enable/disable endpoints call this immediately after
 * flipping `installed_extensions.enabled`, so "disable removes future repeat
 * schedules" holds without a restart (and enable restores them).
 *
 * `sync` derives its desired set from `registry.listActive()` INTERSECTED with
 * the durable `enabled` flag, so a withdraw followed by this call is exactly the
 * removal we want — and a replica whose registry never saw the disable still
 * computes the same desired set instead of re-adding the dead schedule.
 *
 * CALLER CONTRACT: this touches Redis and therefore can throw. The enabled flag
 * is authoritative on its own, so callers treat a failure here as deferred work,
 * not as a failed operation.
 */
export async function resyncExtensionSchedules(
  registry: JobHostRegistry = extensionContributionRegistry,
  queue: JobHostQueue = getExtensionJobsQueue(),
  store: JobHostStore = createExtensionStateStore(),
): Promise<void> {
  // The REAL store: `sync` intersects the registry's replica-local view with the
  // durable enabled flag, so a stub returning `true` would let a stale replica
  // resurrect a disabled extension's repeatables.
  const host = new ExtensionJobHost({ registry, store });
  await host.sync(queue);
}

export async function shutdownExtensionJobHost(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
