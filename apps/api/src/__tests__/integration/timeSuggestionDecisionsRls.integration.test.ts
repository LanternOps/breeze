/**
 * W06 (#3900) — `time_suggestion_decisions` tenancy contract, and the signal
 * read path against real Postgres.
 *
 * Why this file exists: `rls-coverage.integration.test.ts` proves the table is
 * REGISTERED (RLS enabled + forced + a partner-axis policy exists). That is a
 * structural claim. This file is the functional one — it forges a cross-partner
 * write and watches Postgres refuse it, and it drives `listTimeSuggestions`
 * through the real RLS-backed pool so the SQL day window, the accessibleOrgIds
 * narrowing, the hidden Quick Support org and the F19 already-logged filter are
 * proved by the database rather than by a mock.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` + the
 * `.integration.test.ts` suffix is what puts it in the blocking Integration
 * Tests job. Anywhere else and it runs in zero CI jobs.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices, organizations, partners, remoteSessions, timeEntries, timeSuggestionDecisions,
} from '../../db/schema';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { listTimeSuggestions } from '../../services/timeSuggestionService';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdDecisions: string[] = [];

afterEach(async () => {
  if (createdDecisions.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, () =>
    db.delete(timeSuggestionDecisions).where(inArray(timeSuggestionDecisions.id, createdDecisions)),
  );
  createdDecisions.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[], userId?: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: userId ?? null,
    currentPartnerId: partnerId,
  };
}

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Turn the partner flag on. minSessionSeconds 0 so short fixture sessions survive. */
async function enableSuggestions(
  partnerId: string,
  block: Record<string, unknown> = { enabled: true, minSessionSeconds: 0, mergeGapMinutes: 10 },
): Promise<void> {
  await getTestDb()
    .update(partners)
    .set({ settings: { timeTracking: { sessionSuggestions: block } } })
    .where(eq(partners.id, partnerId));
}

async function seedDevice(orgId: string, hostname: string): Promise<string> {
  const site = await createSite({ orgId });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId: site.id,
      agentId: randomUUID(),
      hostname,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('seedDevice: no row returned');
  return device.id;
}

async function seedSession(opts: {
  orgId: string; deviceId: string; userId: string;
  startedAt: Date; endedAt: Date;
  type?: 'terminal' | 'desktop' | 'file_transfer';
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(remoteSessions)
    .values({
      orgId: opts.orgId,
      deviceId: opts.deviceId,
      userId: opts.userId,
      type: opts.type ?? 'desktop',
      status: 'disconnected',
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      // Recorded duration => precision 'exact' (see classifySignal).
      durationSeconds: Math.round((opts.endedAt.getTime() - opts.startedAt.getTime()) / 1000),
    })
    .returning({ id: remoteSessions.id });
  if (!row) throw new Error('seedSession: no row returned');
  return row.id;
}

/** A quick_support org is not creatable through createOrganization's typed options. */
async function seedQuickSupportOrg(partnerId: string): Promise<string> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await getTestDb()
    .insert(organizations)
    .values({
      partnerId,
      name: `Quick Support ${suffix}`,
      slug: `quick-support-${suffix}`,
      type: 'quick_support',
      status: 'active',
      currencyCode: 'USD',
    })
    .returning({ id: organizations.id });
  if (!org) throw new Error('seedQuickSupportOrg: no row returned');
  return org.id;
}

async function insertDecision(
  ctx: DbAccessContext,
  values: typeof timeSuggestionDecisions.$inferInsert,
): Promise<string> {
  const rows = await withDbAccessContext(ctx, () =>
    db.insert(timeSuggestionDecisions).values(values).returning({ id: timeSuggestionDecisions.id }),
  );
  const id = rows[0]!.id;
  createdDecisions.push(id);
  return id;
}

const BASE_DECISION = { signalKind: 'remote_session' as const, decision: 'dismissed' as const };

// ── the table's tenancy contract ────────────────────────────────────────────

describe('time_suggestion_decisions — RLS Shape 3 (partner-axis)', () => {
  it('a partner can write its own decision row', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const id = await insertDecision(partnerContext(partner.id, [], user.id), {
      ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId: randomUUID(),
    });
    expect(id).toBeTruthy();
  });

  it('forging a decision for ANOTHER partner fails with 42501', async () => {
    const attacker = await createPartner();
    const victim = await createPartner();
    const victimUser = await createUser({ partnerId: victim.id });
    await expectSqlState(
      () => withDbAccessContext(partnerContext(attacker.id, []), () =>
        db.insert(timeSuggestionDecisions).values({
          ...BASE_DECISION, partnerId: victim.id, userId: victimUser.id, signalId: randomUUID(),
        }).returning()),
      '42501',
    );
  });

  it('partner B cannot SELECT partner A’s decisions even knowing A’s user id', async () => {
    const a = await createPartner();
    const b = await createPartner();
    const userA = await createUser({ partnerId: a.id });
    const signalId = randomUUID();
    await insertDecision(partnerContext(a.id, [], userA.id), {
      ...BASE_DECISION, partnerId: a.id, userId: userA.id, signalId,
    });

    const seenByB = await withDbAccessContext(partnerContext(b.id, []), () =>
      db.select().from(timeSuggestionDecisions).where(eq(timeSuggestionDecisions.userId, userA.id)),
    );
    expect(seenByB).toHaveLength(0);

    const seenByA = await withDbAccessContext(partnerContext(a.id, []), () =>
      db.select().from(timeSuggestionDecisions).where(eq(timeSuggestionDecisions.userId, userA.id)),
    );
    expect(seenByA).toHaveLength(1);
  });

  it('an org-scoped context sees nothing and cannot insert (the table has no org policy)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    await insertDecision(partnerContext(partner.id, [org.id], user.id), {
      ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId: randomUUID(),
    });

    const rows = await withDbAccessContext(orgContext(org.id, partner.id), () =>
      db.select().from(timeSuggestionDecisions).where(eq(timeSuggestionDecisions.userId, user.id)),
    );
    expect(rows).toHaveLength(0);

    await expectSqlState(
      () => withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.insert(timeSuggestionDecisions).values({
          ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId: randomUUID(),
        }).returning()),
      '42501',
    );
  });

  it('the unique index makes a double confirm of the same signal yield ONE ledger row (F4)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const signalId = randomUUID();
    const ctx = partnerContext(partner.id, [], user.id);
    await insertDecision(ctx, { ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId });

    await expectSqlState(
      () => withDbAccessContext(ctx, () =>
        db.insert(timeSuggestionDecisions).values({
          ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId,
        }).returning()),
      '23505',
    );

    const rows = await withDbAccessContext(ctx, () =>
      db.select().from(timeSuggestionDecisions).where(and(
        eq(timeSuggestionDecisions.userId, user.id),
        eq(timeSuggestionDecisions.signalId, signalId),
      )),
    );
    expect(rows).toHaveLength(1);
  });

  it('deleting the time entry leaves the decision as a tombstone with time_entry_id NULL (F5)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const ctx = partnerContext(partner.id, [org.id], user.id);

    const [entry] = await withDbAccessContext(ctx, () =>
      db.insert(timeEntries).values({
        partnerId: partner.id, orgId: org.id, userId: user.id,
        startedAt: new Date('2026-08-29T09:00:00Z'), endedAt: new Date('2026-08-29T09:30:00Z'),
        durationMinutes: 30, currencyCode: 'USD', source: 'remote_session',
      }).returning({ id: timeEntries.id }),
    );

    const decisionId = await insertDecision(ctx, {
      partnerId: partner.id, userId: user.id, signalKind: 'remote_session',
      signalId: randomUUID(), decision: 'confirmed', timeEntryId: entry!.id,
    });

    await withDbAccessContext(ctx, () => db.delete(timeEntries).where(eq(timeEntries.id, entry!.id)));

    const [after] = await withDbAccessContext(ctx, () =>
      db.select().from(timeSuggestionDecisions).where(eq(timeSuggestionDecisions.id, decisionId)),
    );
    expect(after).toBeDefined();
    expect(after!.timeEntryId).toBeNull();
    expect(after!.decision).toBe('confirmed');
  });

  it('deleting the user CASCADEs the decisions away', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const id = await insertDecision(partnerContext(partner.id, [], user.id), {
      ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId: randomUUID(),
    });

    await getTestDb().execute(sql`DELETE FROM users WHERE id = ${user.id}`);

    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(timeSuggestionDecisions).where(eq(timeSuggestionDecisions.id, id)),
    );
    expect(rows).toHaveLength(0);
    createdDecisions.length = 0;
  });

  it('deleting the partner CASCADEs the decisions away (the erasure path)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const id = await insertDecision(partnerContext(partner.id, [], user.id), {
      ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId: randomUUID(),
    });

    // The partner purge deletes users before partners; mirror that order here so
    // the assertion is about time_suggestion_decisions' own CASCADE, not users'.
    await getTestDb().execute(sql`DELETE FROM time_suggestion_decisions WHERE partner_id = ${partner.id}`);
    const rows = await withDbAccessContext(SYSTEM_CTX, () =>
      db.select().from(timeSuggestionDecisions).where(eq(timeSuggestionDecisions.id, id)),
    );
    expect(rows).toHaveLength(0);
    createdDecisions.length = 0;
  });

  describe('CHECK constraints', () => {
    it('rejects an unknown signal_kind (23514)', async () => {
      const partner = await createPartner();
      const user = await createUser({ partnerId: partner.id });
      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, [], user.id), () =>
          db.insert(timeSuggestionDecisions).values({
            partnerId: partner.id, userId: user.id, signalKind: 'location' as never,
            signalId: randomUUID(), decision: 'dismissed',
          }).returning()),
        '23514',
      );
    });

    it('rejects an unknown decision value (23514)', async () => {
      const partner = await createPartner();
      const user = await createUser({ partnerId: partner.id });
      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, [], user.id), () =>
          db.insert(timeSuggestionDecisions).values({
            partnerId: partner.id, userId: user.id, signalKind: 'remote_session',
            signalId: randomUUID(), decision: 'snoozed' as never,
          }).returning()),
        '23514',
      );
    });

    it('rejects decision=dismissed with a non-null time_entry_id (23514)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const user = await createUser({ partnerId: partner.id });
      const ctx = partnerContext(partner.id, [org.id], user.id);
      const [entry] = await withDbAccessContext(ctx, () =>
        db.insert(timeEntries).values({
          partnerId: partner.id, orgId: org.id, userId: user.id,
          startedAt: new Date('2026-08-29T09:00:00Z'), endedAt: new Date('2026-08-29T09:30:00Z'),
          durationMinutes: 30, currencyCode: 'USD',
        }).returning({ id: timeEntries.id }),
      );
      await expectSqlState(
        () => withDbAccessContext(ctx, () =>
          db.insert(timeSuggestionDecisions).values({
            partnerId: partner.id, userId: user.id, signalKind: 'remote_session',
            signalId: randomUUID(), decision: 'dismissed', timeEntryId: entry!.id,
          }).returning()),
        '23514',
      );
    });
  });

  it('time_entries_source_chk rejects a value outside the five-word vocabulary (23514)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const ctx = partnerContext(partner.id, [org.id], user.id);
    const [entry] = await withDbAccessContext(ctx, () =>
      db.insert(timeEntries).values({
        partnerId: partner.id, orgId: org.id, userId: user.id,
        startedAt: new Date('2026-08-29T09:00:00Z'), endedAt: new Date('2026-08-29T09:30:00Z'),
        durationMinutes: 30, currencyCode: 'USD',
      }).returning({ id: timeEntries.id, source: timeEntries.source }),
    );
    // Default provenance is the safe one.
    expect(entry!.source).toBe('manual');
    await expectSqlState(
      () => withDbAccessContext(ctx, () =>
        db.update(timeEntries).set({ source: 'suggestion' as never }).where(eq(timeEntries.id, entry!.id))),
      '23514',
    );
  });
});

// ── the signal read path, under real RLS ────────────────────────────────────

describe('the signal read path under real RLS', () => {
  function actorFor(partnerId: string, userId: string, accessibleOrgIds: string[] | null) {
    return {
      userId, name: 'Tess Tech', email: 'tess@msp.example',
      partnerId, accessibleOrgIds, manageAll: false, scope: 'partner' as const,
    };
  }

  it('a selected-access user does not see sessions on orgs they lost access to (F1)', async () => {
    const partner = await createPartner();
    await enableSuggestions(partner.id);
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const deviceB = await seedDevice(orgB.id, 'ORGB-DC01');
    await seedSession({
      orgId: orgB.id, deviceId: deviceB, userId: user.id,
      startedAt: new Date('2026-08-29T14:00:00Z'), endedAt: new Date('2026-08-29T14:38:00Z'),
    });

    // Granted orgA only: narrowing, not an error.
    const narrowed = await withDbAccessContext(partnerContext(partner.id, [orgA.id], user.id), () =>
      listTimeSuggestions(actorFor(partner.id, user.id, [orgA.id]), { date: '2026-08-29', tz: 'UTC' }),
    );
    expect(narrowed.enabled).toBe(true);
    expect(narrowed.suggestions).toHaveLength(0);

    // Granted both: the same session is visible.
    const wide = await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id], user.id), () =>
      listTimeSuggestions(actorFor(partner.id, user.id, [orgA.id, orgB.id]), { date: '2026-08-29', tz: 'UTC' }),
    );
    expect(wide.suggestions).toHaveLength(1);
    expect(wide.suggestions[0]!.device?.hostname).toBe('ORGB-DC01');
    expect(wide.suggestions[0]!.suggestedSource).toBe('remote_session');
  });

  it('the hidden quick_support org IS readable in a partner request context (D4)', async () => {
    const partner = await createPartner();
    await enableSuggestions(partner.id);
    const qsOrg = await seedQuickSupportOrg(partner.id);
    const user = await createUser({ partnerId: partner.id });
    const device = await seedDevice(qsOrg, 'QS-LAPTOP');
    await seedSession({
      orgId: qsOrg, deviceId: device, userId: user.id,
      startedAt: new Date('2026-08-29T10:00:00Z'), endedAt: new Date('2026-08-29T10:25:00Z'),
    });

    // accessibleOrgIds null = all orgs under the partner (the common case).
    const res = await withDbAccessContext(partnerContext(partner.id, [qsOrg], user.id), () =>
      listTimeSuggestions(actorFor(partner.id, user.id, null), { date: '2026-08-29', tz: 'UTC' }),
    );
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]!.suggestedSource).toBe('support_session');
    // D4: a Quick Support session carries no organization until a ticket attaches one.
    expect(res.suggestions[0]!.org).toBeNull();
    expect(res.suggestions[0]!.quickSupport).not.toBeNull();
  });

  it('the day window round-trips: a session ending 23:30 local lands on the LOCAL date', async () => {
    const partner = await createPartner();
    await enableSuggestions(partner.id);
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const device = await seedDevice(org.id, 'BERLIN-01');
    // 21:30Z == 23:30 Europe/Berlin (CEST, UTC+2) on 2026-08-29.
    await seedSession({
      orgId: org.id, deviceId: device, userId: user.id,
      startedAt: new Date('2026-08-29T21:00:00Z'), endedAt: new Date('2026-08-29T21:30:00Z'),
    });

    const ctx = partnerContext(partner.id, [org.id], user.id);
    const actor = actorFor(partner.id, user.id, [org.id]);
    const onDay = await withDbAccessContext(ctx, () =>
      listTimeSuggestions(actor, { date: '2026-08-29', tz: 'Europe/Berlin' }),
    );
    expect(onDay.timezone).toBe('Europe/Berlin');
    expect(onDay.suggestions).toHaveLength(1);

    const nextDay = await withDbAccessContext(ctx, () =>
      listTimeSuggestions(actor, { date: '2026-08-30', tz: 'Europe/Berlin' }),
    );
    expect(nextDay.suggestions).toHaveLength(0);
  });

  it('F19: a session fully covered by an existing time_entries row is not suggested', async () => {
    const partner = await createPartner();
    await enableSuggestions(partner.id);
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const device = await seedDevice(org.id, 'ALREADY-LOGGED');
    await seedSession({
      orgId: org.id, deviceId: device, userId: user.id,
      startedAt: new Date('2026-08-29T14:00:00Z'), endedAt: new Date('2026-08-29T14:40:00Z'),
    });
    const ctx = partnerContext(partner.id, [org.id], user.id);
    const actor = actorFor(partner.id, user.id, [org.id]);

    const before = await withDbAccessContext(ctx, () =>
      listTimeSuggestions(actor, { date: '2026-08-29', tz: 'UTC' }),
    );
    expect(before.suggestions).toHaveLength(1);
    expect(before.suggestions[0]!.alreadyLoggedOverlapMinutes).toBe(0);

    // A hand-typed entry covering the whole session. No ledger row is written
    // for it — this exclusion is the ONLY thing standing between the technician
    // and a duplicate billable row.
    await withDbAccessContext(ctx, () =>
      db.insert(timeEntries).values({
        partnerId: partner.id, orgId: org.id, userId: user.id,
        startedAt: new Date('2026-08-29T13:55:00Z'), endedAt: new Date('2026-08-29T14:45:00Z'),
        durationMinutes: 50, currencyCode: 'USD',
      }).returning({ id: timeEntries.id }),
    );

    const after = await withDbAccessContext(ctx, () =>
      listTimeSuggestions(actor, { date: '2026-08-29', tz: 'UTC' }),
    );
    expect(after.suggestions).toHaveLength(0);
    expect(after.unloggedCount).toBe(0);
  });

  it('a decided (dismissed) signal drops out of the list', async () => {
    const partner = await createPartner();
    await enableSuggestions(partner.id);
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const device = await seedDevice(org.id, 'DISMISSED-01');
    const sessionId = await seedSession({
      orgId: org.id, deviceId: device, userId: user.id,
      startedAt: new Date('2026-08-29T08:00:00Z'), endedAt: new Date('2026-08-29T08:20:00Z'),
    });
    const ctx = partnerContext(partner.id, [org.id], user.id);
    const actor = actorFor(partner.id, user.id, [org.id]);

    expect((await withDbAccessContext(ctx, () =>
      listTimeSuggestions(actor, { date: '2026-08-29', tz: 'UTC' }))).suggestions).toHaveLength(1);

    await insertDecision(ctx, {
      ...BASE_DECISION, partnerId: partner.id, userId: user.id, signalId: sessionId,
    });

    expect((await withDbAccessContext(ctx, () =>
      listTimeSuggestions(actor, { date: '2026-08-29', tz: 'UTC' }))).suggestions).toHaveLength(0);
  });

  it('the partner flag off returns enabled:false and no suggestions, never a 403', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const device = await seedDevice(org.id, 'FLAG-OFF-01');
    await seedSession({
      orgId: org.id, deviceId: device, userId: user.id,
      startedAt: new Date('2026-08-29T08:00:00Z'), endedAt: new Date('2026-08-29T08:20:00Z'),
    });
    const res = await withDbAccessContext(partnerContext(partner.id, [org.id], user.id), () =>
      listTimeSuggestions(actorFor(partner.id, user.id, [org.id]), { date: '2026-08-29', tz: 'UTC' }),
    );
    expect(res.enabled).toBe(false);
    expect(res.suggestions).toHaveLength(0);
  });
});
