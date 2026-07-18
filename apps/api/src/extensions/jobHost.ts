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
import type {
  ExtensionContributionRegistry,
  StagedExtensionContributions,
} from './contributionRegistry';
import type { ExtensionStateStore } from './stateStore';
import { recordExtensionJob } from './metrics';

export const EXTENSION_JOBS_QUEUE = 'breeze-extension-jobs';
const WORKER_CONCURRENCY = 4;
const REMOVE_ON_COMPLETE = { count: 50 };
const REMOVE_ON_FAIL = { count: 100 };

/** Stable, collision-free repeatable id for one (extension, job) pair. */
export function extensionJobId(extension: string, job: string): string {
  return `extension-${extension}-${job}`;
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
  // `id` is widened to include `undefined` because that is what BullMQ's
  // `RepeatableJob` actually carries; narrowing it here would make the real
  // Queue unassignable to this port.
  getRepeatableJobs(): Promise<Array<{ key: string; name: string; id?: string | null }>>;
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
  /** Clock seam for duration measurement (tests). */
  now?: () => number;
}

export class ExtensionJobHost {
  private readonly registry: JobHostRegistry;
  private readonly store: JobHostStore;
  private readonly recordJob: NonNullable<ExtensionJobHostDeps['recordJob']>;
  private readonly now: () => number;

  constructor(deps: ExtensionJobHostDeps) {
    this.registry = deps.registry;
    this.store = deps.store;
    this.recordJob = deps.recordJob ?? recordExtensionJob;
    this.now = deps.now ?? (() => Date.now());
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

    const startedAt = this.now();
    try {
      await definition.handler();
      this.recordJob(extension, jobName, 'success', (this.now() - startedAt) / 1000);
    } catch (error) {
      // Record the failure, then let it reach BullMQ retry handling untouched.
      this.recordJob(extension, jobName, 'failure', (this.now() - startedAt) / 1000);
      throw error;
    }
  }

  /**
   * Reconcile the queue's repeatable schedules against the desired set derived
   * from the active extensions' declared jobs: remove OUR stale repeatables,
   * then (re)add every currently-desired one. Non-extension repeatables (other
   * workers sharing Redis) are never touched.
   */
  async sync(
    queue: JobHostQueue,
    active: readonly StagedExtensionContributions[] = this.registry.listActive(),
  ): Promise<void> {
    const desired = new Map<string, { extension: string; job: string; cron: string }>();
    for (const snapshot of active) {
      for (const definition of snapshot.jobs.values()) {
        const id = extensionJobId(snapshot.name, definition.name);
        desired.set(id, { extension: snapshot.name, job: definition.name, cron: definition.cron });
      }
    }

    const existing = await queue.getRepeatableJobs();
    for (const entry of existing) {
      // Only manage repeatables we own; leave every other worker's alone.
      if (!entry.id || !entry.id.startsWith('extension-')) continue;
      if (!desired.has(entry.id)) {
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

export async function shutdownExtensionJobHost(): Promise<void> {
  if (worker) { await worker.close(); worker = null; }
  if (queue) { await queue.close(); queue = null; }
}
