import './setup';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { aiBudgetReservations, aiBudgets, aiCostUsage, aiSessions } from '../../db/schema';
import {
  markAiBudgetReservationIndeterminate,
  releaseUnusedAiBudgetReservation,
  reserveAiBudget,
  settleAiBudgetReservation,
} from '../../services/aiBudgetReservations';
import { assertTestDatabaseUrlSafe } from '../../testUtils/integrationDatabaseSafety';
import { createOrganization, createPartner } from './db-utils';

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

async function makeOrgWithBudget(dailyBudgetCents: number | null, monthlyBudgetCents: number | null) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  await withDbAccessContext(orgContext(org.id), () =>
    db.insert(aiBudgets).values({ orgId: org.id, dailyBudgetCents, monthlyBudgetCents }),
  );
  return org;
}

describe('durable AI budget reservations', () => {
  it('serializes concurrent capped reservations and reserves the full remaining bound', async () => {
    const org = await makeOrgWithBudget(100, 500);

    const reserve = (idempotencyKey: string) => withDbAccessContext(orgContext(org.id), () =>
      reserveAiBudget({
        orgId: org.id,
        idempotencyKey,
        billingSource: 'platform',
        now: new Date('2026-09-06T12:00:00.000Z'),
      }),
    );

    const results = await Promise.all([reserve('concurrent-a'), reserve('concurrent-b')]);
    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'denied')).toHaveLength(1);
    expect(results.find((result) => result.kind === 'reserved')).toMatchObject({
      reservedCostCents: 100,
      dailyPeriodKey: '2026-09-06',
      monthlyPeriodKey: '2026-09',
    });
    const winnerIndex = results.findIndex((result) => result.kind === 'reserved');
    const winner = results[winnerIndex];
    if (!winner || winner.kind !== 'reserved') throw new Error('expected one reservation winner');
    await expect(reserve(winnerIndex === 0 ? 'concurrent-a' : 'concurrent-b')).resolves.toMatchObject({
      kind: 'reserved',
      reservationId: winner.reservationId,
      reservedCostCents: 100,
    });

    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select().from(aiBudgetReservations).where(eq(aiBudgetReservations.orgId, org.id)),
    );
    expect(rows).toHaveLength(1);
  });

  it('enforces direct-org forced RLS for reads and forged inserts', async () => {
    const partner = await createPartner();
    const ownOrg = await createOrganization({ partnerId: partner.id });
    const foreignOrg = await createOrganization({ partnerId: partner.id });

    const own = await withDbAccessContext(orgContext(ownOrg.id), () => reserveAiBudget({
      orgId: ownOrg.id,
      idempotencyKey: 'own-org',
      billingSource: 'platform',
    }));
    expect(own.kind).toBe('unlimited');

    const hidden = await withDbAccessContext(orgContext(foreignOrg.id), () =>
      db.select().from(aiBudgetReservations).where(eq(aiBudgetReservations.orgId, ownOrg.id)),
    );
    expect(hidden).toEqual([]);

    await expect(withDbAccessContext(orgContext(foreignOrg.id), () =>
      db.insert(aiBudgetReservations).values({
        orgId: ownOrg.id,
        idempotencyKey: 'forged-cross-org',
        billingSource: 'platform',
        dailyPeriodKey: '2026-09-06',
        monthlyPeriodKey: '2026-09',
        reservedCostCents: '1',
      }),
    )).rejects.toMatchObject({ cause: { code: '42501' } });

    const [foreignSession] = await withDbAccessContext(orgContext(foreignOrg.id), () =>
      db.insert(aiSessions).values({ orgId: foreignOrg.id }).returning({ id: aiSessions.id }),
    );
    if (!foreignSession) throw new Error('expected foreign session fixture');
    await expect(withDbAccessContext(orgContext(ownOrg.id), () =>
      db.insert(aiBudgetReservations).values({
        orgId: ownOrg.id,
        sessionId: foreignSession.id,
        idempotencyKey: 'forged-cross-org-session',
        billingSource: 'platform',
        dailyPeriodKey: '2026-09-06',
        monthlyPeriodKey: '2026-09',
        reservedCostCents: '1',
      }),
    )).rejects.toMatchObject({ cause: { code: '23503' } });

    const [ownSession] = await withDbAccessContext(orgContext(ownOrg.id), () =>
      db.insert(aiSessions).values({ orgId: ownOrg.id }).returning({ id: aiSessions.id }),
    );
    if (!ownSession) throw new Error('expected own session fixture');
    const sessionReservation = await withDbAccessContext(orgContext(ownOrg.id), () => reserveAiBudget({
      orgId: ownOrg.id,
      sessionId: ownSession.id,
      idempotencyKey: 'same-org-session',
      billingSource: 'platform',
    }));
    if (sessionReservation.kind === 'denied') throw new Error('expected own session reservation');
    await expect(withDbAccessContext(orgContext(ownOrg.id), () => settleAiBudgetReservation({
      orgId: ownOrg.id,
      reservationId: sessionReservation.reservationId,
      actualCostCents: 0,
      inputTokens: 0,
      outputTokens: 0,
    }))).rejects.toThrow(/requires session settlement/i);
    await withDbAccessContext(orgContext(ownOrg.id), () =>
      db.delete(aiSessions).where(eq(aiSessions.id, ownSession.id)),
    );
    const [preserved] = await withDbAccessContext(orgContext(ownOrg.id), () => db
      .select({ orgId: aiBudgetReservations.orgId, sessionId: aiBudgetReservations.sessionId })
      .from(aiBudgetReservations)
      .where(eq(aiBudgetReservations.id, sessionReservation.reservationId)),
    );
    expect(preserved).toEqual({ orgId: ownOrg.id, sessionId: null });
  });

  it('settles daily and monthly usage atomically and rejects a conflicting replay', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const reserved = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'settlement',
      billingSource: 'platform',
      now: new Date('2026-09-06T12:00:00.000Z'),
    }));
    if (reserved.kind !== 'reserved') throw new Error('expected capped reservation');

    const settlement = {
      orgId: org.id,
      reservationId: reserved.reservationId,
      actualCostCents: 12.345678,
      inputTokens: 101,
      outputTokens: 17,
      messageCount: 1,
      toolExecutionCount: 0,
      settledAt: new Date('2026-09-06T12:01:00.000Z'),
    };
    await expect(withDbAccessContext(orgContext(org.id), () =>
      settleAiBudgetReservation(settlement),
    )).resolves.toMatchObject({ kind: 'settled', actualCostCents: 12.345678 });
    await expect(withDbAccessContext(orgContext(org.id), () =>
      settleAiBudgetReservation(settlement),
    )).resolves.toMatchObject({ kind: 'already_settled' });
    await expect(withDbAccessContext(orgContext(org.id), () =>
      settleAiBudgetReservation({ ...settlement, actualCostCents: 12.345679 }),
    )).rejects.toThrow(/conflicting settlement/i);

    const aggregates = await withDbAccessContext(orgContext(org.id), () => db
      .select()
      .from(aiCostUsage)
      .where(and(eq(aiCostUsage.orgId, org.id), eq(aiCostUsage.billingSource, 'platform'))),
    );
    expect(aggregates).toHaveLength(2);
    expect(aggregates.map((row) => [row.period, row.periodKey])).toEqual(expect.arrayContaining([
      ['daily', '2026-09-06'],
      ['monthly', '2026-09'],
    ]));
    for (const aggregate of aggregates) {
      expect(Number(aggregate.totalCostCents)).toBeCloseTo(12.345678, 6);
      expect(aggregate.inputTokens).toBe(101);
      expect(aggregate.outputTokens).toBe(17);
    }
  });

  it('does not manufacture capacity after high-magnitude fractional settlements', async () => {
    const org = await makeOrgWithBudget(2_000_000_001, 2_000_000_001);
    const at = new Date('2026-09-06T12:00:00.000Z');
    const first = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'high-magnitude-first',
      billingSource: 'platform',
      now: at,
    }));
    if (first.kind !== 'reserved') throw new Error('expected first capped reservation');
    await withDbAccessContext(orgContext(org.id), () => settleAiBudgetReservation({
      orgId: org.id,
      reservationId: first.reservationId,
      actualCostCents: 2_000_000_000.123456,
      inputTokens: 1,
      outputTokens: 1,
      settledAt: at,
    }));

    const second = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'high-magnitude-second',
      billingSource: 'platform',
      now: at,
    }));
    if (second.kind !== 'reserved') throw new Error('expected exact fractional remainder');
    expect(second.reservedCostCents).toBeCloseTo(0.876544, 6);
    await withDbAccessContext(orgContext(org.id), () => settleAiBudgetReservation({
      orgId: org.id,
      reservationId: second.reservationId,
      actualCostCents: 0.876544,
      inputTokens: 1,
      outputTokens: 1,
      settledAt: at,
    }));

    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'high-magnitude-third',
      billingSource: 'platform',
      now: at,
    }))).resolves.toMatchObject({ kind: 'denied', reason: 'daily_budget' });
  });

  it('treats enabled zero as a cap and never refunds indeterminate usage', async () => {
    const zeroOrg = await makeOrgWithBudget(0, null);
    await expect(withDbAccessContext(orgContext(zeroOrg.id), () => reserveAiBudget({
      orgId: zeroOrg.id,
      idempotencyKey: 'zero-cap',
      billingSource: 'platform',
    }))).resolves.toMatchObject({ kind: 'denied', reason: 'daily_budget' });

    const org = await makeOrgWithBudget(25, null);
    const first = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'unknown-outcome',
      billingSource: 'platform',
    }));
    if (first.kind !== 'reserved') throw new Error('expected capped reservation');
    await withDbAccessContext(orgContext(org.id), () => markAiBudgetReservationIndeterminate({
      orgId: org.id,
      reservationId: first.reservationId,
    }));
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'unknown-outcome',
      billingSource: 'platform',
    }))).rejects.toThrow(/indeterminate provider outcome/i);
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'after-unknown',
      billingSource: 'platform',
    }))).resolves.toMatchObject({ kind: 'denied', reason: 'daily_budget' });
    await expect(withDbAccessContext(orgContext(org.id), () => releaseUnusedAiBudgetReservation({
      orgId: org.id,
      reservationId: first.reservationId,
    }))).rejects.toThrow(/indeterminate.*cannot be released/i);
  });

  it('releases only proven pre-dispatch reservations and restores capacity', async () => {
    const org = await makeOrgWithBudget(25, null);
    const first = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'pre-dispatch-failed',
      billingSource: 'platform',
    }));
    if (first.kind !== 'reserved') throw new Error('expected capped reservation');
    await expect(withDbAccessContext(orgContext(org.id), () => releaseUnusedAiBudgetReservation({
      orgId: org.id,
      reservationId: first.reservationId,
    }))).resolves.toMatchObject({ kind: 'released' });
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'after-release',
      billingSource: 'platform',
    }))).resolves.toMatchObject({ kind: 'reserved', reservedCostCents: 25 });
  });

  it('the handwritten migration can be applied repeatedly', async () => {
    const url = process.env.DATABASE_URL
      ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
    assertTestDatabaseUrlSafe(url, 'ai-budget-reservations migration idempotency');
    const client = postgres(url, { max: 1 });
    const migrationPaths = [
      '2026-10-15-160100-ai-budget-reservations.sql',
      '2026-10-15-160101-ai-cost-numeric.sql',
      '2026-10-15-160102-ai-budget-reservation-session-org-fk.sql',
    ].map((filename) => fileURLToPath(new URL(`../../../migrations/${filename}`, import.meta.url)));
    const migrations = await Promise.all(migrationPaths.map((migrationPath) => readFile(migrationPath, 'utf8')));
    try {
      for (const migration of migrations) {
        await client.unsafe(migration);
        await client.unsafe(migration);
      }
    } finally {
      await client.end();
    }
  });
});
