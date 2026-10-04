/**
 * Scheduled discovery scans must reach the dispatch worker only after the job
 * row has committed (#7187 enqueue-before-commit hazard).
 *
 * The schedule-profiles handler runs inside one system transaction. It used to
 * enqueue `dispatch-scan` from inside that transaction, so a fast dispatch
 * worker — which reads the row on its own connection — found no row, logged
 * "status is missing", and returned. The row then stayed 'scheduled' forever
 * and `hasActiveJob` skipped its profile on every later tick.
 *
 * Real Postgres; only BullMQ is faked. The fake queue's `add` looks the job up
 * on a SEPARATE connection, which is exactly what the dispatch worker does.
 */
import '../__tests__/integration/setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { addCalls } = vi.hoisted(() => ({
  addCalls: [] as Array<{ jobId: string; visibleStatus: string | null }>,
}));

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  const { getTestDb } = await import('../__tests__/integration/setup');
  const { discoveryJobs } = await import('../db/schema');
  class FakeQueue {
    async getJob() {
      return undefined;
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
import { __testables, STALE_SCHEDULED_JOB_MINUTES } from './discoveryWorker';

async function cronProfileDueEveryMinute() {
  const scope = await createTopologyTenant();
  const [profile] = await getTestDb().insert(discoveryProfiles).values({
    orgId: scope.orgId,
    siteId: scope.siteId,
    name: 'every-minute fixture',
    subnets: ['192.0.2.0/24'],
    methods: ['ping'],
    schedule: { type: 'cron', cron: '* * * * *', timezone: 'UTC' },
  }).returning();
  if (!profile) throw new Error('profile insert failed');
  return { scope, profile };
}

/** Runs the handler exactly as createDiscoveryWorker does: inside one system context. */
async function runScheduleTick() {
  return withSystemDbAccessContext(() => __testables.processScheduleProfiles());
}

afterEach(() => {
  addCalls.length = 0;
});

describe('scheduled discovery dispatch waits for commit', () => {
  it('enqueues the dispatch only once the scheduled job row is visible to other connections', async () => {
    const { profile } = await cronProfileDueEveryMinute();

    await runScheduleTick();

    const [job] = await getTestDb()
      .select({ id: discoveryJobs.id, status: discoveryJobs.status })
      .from(discoveryJobs)
      .where(eq(discoveryJobs.profileId, profile.id));
    expect(job?.status).toBe('scheduled');

    // The deferred enqueue starts once the context has exited.
    await vi.waitFor(() => {
      expect(addCalls.some((c) => c.jobId === job!.id)).toBe(true);
    });
    const call = addCalls.find((c) => c.jobId === job!.id)!;
    // Before the fix this was null: the worker saw "status is missing".
    expect(call.visibleStatus).toBe('scheduled');
  });

  it('fails a job left scheduled past the bound so its profile is scheduled again', async () => {
    const { scope, profile } = await cronProfileDueEveryMinute();
    const longAgo = new Date(Date.now() - (STALE_SCHEDULED_JOB_MINUTES + 5) * 60 * 1000);
    const [stuck] = await getTestDb().insert(discoveryJobs).values({
      profileId: profile.id,
      orgId: scope.orgId,
      siteId: scope.siteId,
      status: 'scheduled',
      scheduledAt: longAgo,
      createdAt: longAgo,
      updatedAt: longAgo,
    }).returning();

    await runScheduleTick();

    const [after] = await getTestDb().select().from(discoveryJobs).where(eq(discoveryJobs.id, stuck!.id));
    expect(after?.status).toBe('failed');
    expect((after?.errors as { message?: string } | null)?.message).toMatch(/never dispatched/);

    // The profile is no longer blocked: the same tick admitted a fresh run.
    const jobs = await getTestDb().select().from(discoveryJobs).where(eq(discoveryJobs.profileId, profile.id));
    expect(jobs.filter((j) => j.status === 'scheduled')).toHaveLength(1);
  });

  it('leaves a recently scheduled job alone', async () => {
    const { scope, profile } = await cronProfileDueEveryMinute();
    const recent = new Date(Date.now() - 60 * 1000);
    const [fresh] = await getTestDb().insert(discoveryJobs).values({
      profileId: profile.id,
      orgId: scope.orgId,
      siteId: scope.siteId,
      status: 'scheduled',
      scheduledAt: recent,
      createdAt: recent,
      updatedAt: recent,
    }).returning();

    await runScheduleTick();

    const [after] = await getTestDb().select().from(discoveryJobs).where(eq(discoveryJobs.id, fresh!.id));
    expect(after?.status).toBe('scheduled');
    // Still counts as active, so no second job was admitted.
    const jobs = await getTestDb().select().from(discoveryJobs).where(eq(discoveryJobs.profileId, profile.id));
    expect(jobs).toHaveLength(1);
  });
});
