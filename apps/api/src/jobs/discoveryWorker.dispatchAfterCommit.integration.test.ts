/**
 * Scheduled discovery scans must reach the dispatch worker only after the job
 * row has committed (#7187 enqueue-before-commit hazard), and a job whose
 * dispatch was lost must not block its profile forever.
 *
 * The schedule-profiles handler runs inside one system transaction. It used to
 * enqueue `dispatch-scan` from inside that transaction, so a fast dispatch
 * worker — which reads the row on its own connection — found no row, logged
 * "status is missing", and returned. The row then stayed 'scheduled' forever
 * and `hasActiveJob` skipped its profile on every later tick.
 *
 * Real Postgres; only BullMQ is faked. The fake queue's `add` looks the job up
 * on a SEPARATE connection, which is exactly what the dispatch worker does, and
 * `getJob` reports a dispatch as in flight for ids listed in `inFlight`.
 */
import '../__tests__/integration/setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { addCalls, inFlight } = vi.hoisted(() => ({
  addCalls: [] as Array<{ jobId: string; visibleStatus: string | null }>,
  inFlight: new Set<string>(),
}));

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  const { getTestDb } = await import('../__tests__/integration/setup');
  const { discoveryJobs } = await import('../db/schema');
  class FakeQueue {
    async getJob(queueJobId: string) {
      if (!inFlight.has(queueJobId)) return undefined;
      return { getState: async () => 'active', remove: async () => {} };
    }
    async add(_name: string, data: { jobId?: string }) {
      const jobId = String(data.jobId);
      const [row] = await getTestDb()
        .select({ status: discoveryJobs.status })
        .from(discoveryJobs)
        .where(eq(discoveryJobs.id, jobId));
      addCalls.push({ jobId, visibleStatus: row?.status ?? null });
      return { id: `discovery-dispatch-${jobId}` };
    }
  }
  return { ...actual, Queue: FakeQueue };
});

import { getTestDb } from '../__tests__/integration/setup';
import { createTopologyTenant } from '../__tests__/integration/topology-fixtures';
import { withSystemDbAccessContext } from '../db';
import { discoveryJobs, discoveryProfiles } from '../db/schema';
import { __testables, REDISPATCH_BATCH_LIMIT } from './discoveryWorker';

async function cronProfile(cron: string) {
  const scope = await createTopologyTenant();
  const [profile] = await getTestDb().insert(discoveryProfiles).values({
    orgId: scope.orgId,
    siteId: scope.siteId,
    name: 'scheduler fixture',
    subnets: ['192.0.2.0/24'],
    methods: ['ping'],
    schedule: { type: 'cron', cron, timezone: 'UTC' },
  }).returning();
  if (!profile) throw new Error('profile insert failed');
  return { scope, profile };
}

/** A cron that is never due during the test (Feb 30), so only the sweep acts. */
const NEVER_DUE = '0 0 30 2 *';

async function scheduledJob(scope: { orgId: string; siteId: string }, profileId: string, minutesAgo: number) {
  const at = new Date(Date.now() - minutesAgo * 60 * 1000);
  const [job] = await getTestDb().insert(discoveryJobs).values({
    profileId,
    orgId: scope.orgId,
    siteId: scope.siteId,
    status: 'scheduled',
    scheduledAt: at,
    createdAt: at,
    updatedAt: at,
  }).returning();
  return job!;
}

/** Runs the handler exactly as createDiscoveryWorker does: inside one system context. */
async function runScheduleTick() {
  return withSystemDbAccessContext(() => __testables.processScheduleProfiles());
}

async function jobsFor(profileId: string) {
  return getTestDb().select().from(discoveryJobs).where(eq(discoveryJobs.profileId, profileId));
}

/** Deferred queue work is fire-and-forget; give it time to settle. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 300));
}

afterEach(() => {
  addCalls.length = 0;
  inFlight.clear();
});

describe('scheduled discovery dispatch waits for commit', () => {
  it('enqueues the dispatch only once the scheduled job row is visible to other connections', async () => {
    const { profile } = await cronProfile('* * * * *');

    await runScheduleTick();

    const [job] = await jobsFor(profile.id);
    expect(job?.status).toBe('scheduled');
    await vi.waitFor(() => {
      expect(addCalls.some((c) => c.jobId === job!.id)).toBe(true);
    });
    // Before the fix this was null: the worker saw "status is missing".
    expect(addCalls.find((c) => c.jobId === job!.id)!.visibleStatus).toBe('scheduled');
  });
});

describe('undispatched scheduled jobs', () => {
  it('re-dispatches the SAME job when its dispatch was lost, without failing it or admitting a replacement', async () => {
    const { scope, profile } = await cronProfile(NEVER_DUE);
    const stuck = await scheduledJob(scope, profile.id, 5);

    await runScheduleTick();
    await vi.waitFor(() => expect(addCalls.map((c) => c.jobId)).toContain(stuck.id));

    expect(addCalls.find((c) => c.jobId === stuck.id)!.visibleStatus).toBe('scheduled');
    const jobs = await jobsFor(profile.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('scheduled');
  });

  it('leaves a job alone while its dispatch is queued or running: no re-enqueue, no failure, no duplicate', async () => {
    const { scope, profile } = await cronProfile('* * * * *');
    const slow = await scheduledJob(scope, profile.id, 60);
    inFlight.add(`discovery-dispatch-${slow.id}`);

    await runScheduleTick();
    await settle();

    expect(addCalls.map((c) => c.jobId)).not.toContain(slow.id);
    const jobs = await jobsFor(profile.id);
    // Still scheduled, and hasActiveJob still holds the profile.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('scheduled');
  });

  it('reaches a lost job behind a full batch of in-flight ones on the next tick', async () => {
    const { scope, profile } = await cronProfile(NEVER_DUE);
    // A full batch of OLDER stale rows whose dispatches are all still queued.
    const older: Array<{ id: string }> = [];
    for (let i = 0; i < REDISPATCH_BATCH_LIMIT; i += 1) {
      const job = await scheduledJob(scope, profile.id, 120 + i);
      inFlight.add(`discovery-dispatch-${job.id}`);
      older.push(job);
    }
    const lost = await scheduledJob(scope, profile.id, 10);

    await runScheduleTick();
    await settle();
    expect(addCalls.map((c) => c.jobId)).not.toContain(lost.id);

    await runScheduleTick();
    await vi.waitFor(() => expect(addCalls.map((c) => c.jobId)).toContain(lost.id));
    expect(addCalls.map((c) => c.jobId).filter((id) => older.some((o) => o.id === id))).toEqual([]);
  });

  it('does not touch a job scheduled moments ago', async () => {
    const { scope, profile } = await cronProfile('* * * * *');
    const fresh = await scheduledJob(scope, profile.id, 1);

    await runScheduleTick();
    await settle();

    expect(addCalls.map((c) => c.jobId)).not.toContain(fresh.id);
    const jobs = await jobsFor(profile.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('scheduled');
  });
});
