import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents } from '../../db/schema';
import { aiRunWorkspaces } from '../../db/schema/aiWorkspace';
import { createOrganization, createPartner, createUser } from './db-utils';

/**
 * Live-Postgres proof for the reaper's hand-written claim query
 * (jobs/workspaceReaper.ts). The unit suite mocks `db.execute` entirely, so it
 * only ever asserts the SQL *string* it built — it cannot catch a column that
 * no longer exists, a CTE that does not parse, an RLS scope that matches zero
 * rows, or a grace window that is off by a factor of sixty. All four of those
 * fail silently in production while every unit test stays green, which is the
 * exact shape CLAUDE.md records as "contract tests caught it 5/5, review 0/5".
 *
 * The destroy half is deliberately NOT exercised here: it dispatches to a
 * vendor backend and is already covered against a fake in the unit suite. What
 * only a real database can answer is whether the claim query does what it says.
 */

interface Seed {
  orgId: string;
  runId: string;
}

async function seedRun(): Promise<Seed> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });

  const runId = await withSystemDbAccessContext(async () => {
    const [agent] = await db
      .insert(aiAgents)
      .values({
        orgId: org.id,
        partnerId: null,
        kind: 'triage',
        name: 'Reaper fixture',
        createdBy: user.id,
      })
      .returning({ id: aiAgents.id });
    const [run] = await db
      .insert(aiAgentRuns)
      .values({
        agentId: agent!.id,
        orgId: org.id,
        triggerKind: 'manual',
        dedupeKey: `reaper-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
      })
      .returning({ id: aiAgentRuns.id });
    return run!.id as string;
  });

  return { orgId: org.id, runId };
}

/** Minutes relative to now, as the provider-side deadline. */
function deadline(minutesFromNow: number): Date {
  return new Date(Date.now() + minutesFromNow * 60_000);
}

async function insertWorkspace(
  seed: Seed,
  providerRef: string,
  status: 'creating' | 'ready' | 'destroying' | 'destroyed' | 'destroy_failed',
  deadlineAt: Date,
): Promise<string> {
  return await withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(aiRunWorkspaces)
      .values({
        orgId: seed.orgId,
        runId: seed.runId,
        backend: 'fake',
        providerRef,
        region: 'eu',
        status,
        deadlineAt,
      })
      .returning({ id: aiRunWorkspaces.id });
    return row!.id as string;
  });
}

async function statusOf(ids: string[]): Promise<Record<string, string>> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: aiRunWorkspaces.id, status: aiRunWorkspaces.status, ref: aiRunWorkspaces.providerRef })
      .from(aiRunWorkspaces)
      .where(inArray(aiRunWorkspaces.id, ids)),
  );
  return Object.fromEntries(rows.map((r) => [r.ref, r.status]));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await withSystemDbAccessContext(() => db.delete(aiRunWorkspaces));
});

describe('workspace reaper claim query (live Postgres)', () => {
  let seed: Seed;

  beforeEach(async () => {
    seed = await seedRun();
  });

  it('claims only rows past deadline_at + the 120s grace, and flips them to destroying', async () => {
    // The unique index is partial on `status <> 'destroyed'`, so only ONE of
    // these rows may be live per run at a time — each case therefore uses its
    // own run.
    const overdue = await insertWorkspace(seed, 'overdue', 'ready', deadline(-5));
    const other = await seedRun();
    const insideGrace = await insertWorkspace(other, 'inside-grace', 'ready', new Date(Date.now() - 30_000));
    const future = await seedRun();
    const notDue = await insertWorkspace(future, 'not-due', 'ready', deadline(30));

    const { reapExpiredWorkspaces } = await import('../../jobs/workspaceReaper');
    // Called bare, exactly as the worker calls it: the function opens its own
    // short-lived system contexts (one for the claim, one per row) so that no
    // pooled connection is held across a vendor round-trip. Getting the context
    // wrong is not a loud failure — a contextless connection under FORCE ROW
    // LEVEL SECURITY is a DENY, not a bypass, so the claim would match zero rows
    // and report a truthful-looking "0 destroyed" forever. This suite is what
    // catches that; it did, once, during development.
    //
    // Destroy dispatches to the in-process fake backend, whose handle does not
    // exist — so every claimed row lands in destroy_failed. That is fine and is
    // exactly what proves the claim half ran: an unclaimed row stays 'ready'.
    await reapExpiredWorkspaces();

    const after = await statusOf([overdue, insideGrace, notDue]);
    expect(after['overdue'], 'a row 5 minutes past its deadline must be claimed').not.toBe('ready');
    expect(after['inside-grace'], '30s past the deadline is inside the 120s grace').toBe('ready');
    expect(after['not-due'], 'a future deadline must never be claimed').toBe('ready');
  });

  it('reclaims a STALLED destroying row, whose claimer died before destroying it', async () => {
    // The claiming process was OOM-killed / redeployed between the claim and the
    // destroy. Nothing else in the system ever looks at a `destroying` row, so
    // without this sweep the sandbox bills forever, watched by nobody and paged
    // by nothing (it never reaches destroy_failed either).
    const stalled = await insertWorkspace(seed, 'stalled', 'destroying', deadline(-60));
    await withSystemDbAccessContext(() =>
      db
        .update(aiRunWorkspaces)
        .set({ destroyingSince: new Date(Date.now() - 3_600_000) })
        .where(eq(aiRunWorkspaces.id, stalled)),
    );

    const { reapExpiredWorkspaces } = await import('../../jobs/workspaceReaper');
    await reapExpiredWorkspaces();

    const after = await statusOf([stalled]);
    expect(after['stalled'], 'a stalled claim must be picked back up').not.toBe('destroying');
  });

  it('never re-claims a row another instance already moved to destroying or destroyed', async () => {
    // Freshly claimed (destroying_since = now), so the stall sweep must not take
    // it: another instance is actively working on it right now.
    const held = await insertWorkspace(seed, 'held', 'destroying', deadline(-10));
    await withSystemDbAccessContext(() =>
      db.update(aiRunWorkspaces).set({ destroyingSince: new Date() }).where(eq(aiRunWorkspaces.id, held)),
    );
    const destroying = held;
    const doneSeed = await seedRun();
    const done = await insertWorkspace(doneSeed, 'done', 'destroyed', deadline(-10));

    const { reapExpiredWorkspaces } = await import('../../jobs/workspaceReaper');
    await reapExpiredWorkspaces();

    const after = await statusOf([destroying, done]);
    expect(after['held'], 'another instance owns it').toBe('destroying');
    expect(after['done'], 'already destroyed rows are terminal').toBe('destroyed');
  });
});
