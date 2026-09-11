import './setup';

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { sweepExpiredAiBudgetReservations } from '../../jobs/aiBudgetReservationSweep';
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
    // S4: the cap is held, not spent — `ai_cost_usage` is still empty — so the
    // denial says in-flight. The capacity is genuinely unavailable either way;
    // only the message the operator reads differs.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'after-unknown',
      billingSource: 'platform',
    }))).resolves.toMatchObject({ kind: 'denied', reason: 'daily_budget_in_flight' });
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

  // -------------------------------------------------------------------------
  // Review B2 — connection cost of one admission
  // -------------------------------------------------------------------------

  it('completes 20 concurrent admissions for one org without exhausting the pool', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const CONCURRENCY = 20;

    const activeBackends = async (): Promise<number> => {
      const result = await withSystemDbAccessContext(() => db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state IS NOT NULL AND state <> 'idle'
      `));
      const list = (result as unknown as { rows?: Array<{ n: number }> }).rows
        ?? (result as unknown as Array<{ n: number }>);
      return list[0]?.n ?? 0;
    };

    const baseline = await activeBackends();
    let peak = baseline;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        peak = Math.max(peak, await activeBackends().catch(() => 0));
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    // Each admission runs INSIDE a request DB context, which is the shape that
    // made this expensive: connection 1 is the request transaction, connection
    // 2 is the reservation's own. Before the fix the partner-axis read inside
    // getEffectiveAiBudget opened a THIRD while connection 2 still held
    // `organizations FOR UPDATE`, so ~15 of these wedged the whole pool and
    // this promise never resolved.
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, index) =>
        withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
          orgId: org.id,
          idempotencyKey: `pool-pressure-${index}`,
          billingSource: 'platform',
          now: new Date('2026-09-10T12:00:00.000Z'),
        })),
      ),
    );
    sampling = false;
    await sampler;

    expect(results).toHaveLength(CONCURRENCY);
    // Exactly one wins the whole remaining cap; the rest are denied, not hung.
    expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'denied')).toHaveLength(CONCURRENCY - 1);
    // At most two backends per in-flight admission. Three-per-admission is the
    // regression; the completion assertion above is what actually catches a
    // pool deadlock, and this bounds the steady-state cost.
    expect(peak - baseline).toBeLessThanOrEqual(2 * CONCURRENCY);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Review S4 — an in-flight hold is not exhaustion
  // -------------------------------------------------------------------------

  it('denies a rival dispatch as in-flight, not exhausted, while nothing has been spent', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const held = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'holder', billingSource: 'platform',
    }));
    expect(held.kind).toBe('reserved');

    const rival = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'rival', billingSource: 'platform',
    }));
    expect(rival).toMatchObject({
      kind: 'denied',
      reason: 'daily_budget_in_flight',
      message: "Another AI request is in flight against this organization's budget; retry shortly",
    });
    // The distinction is load-bearing: `ai_cost_usage` is still empty, so
    // "Daily AI budget exhausted ($1.00)" would send the operator to billing
    // for a condition that clears in seconds.
    const usage = await withDbAccessContext(orgContext(org.id), () =>
      db.select().from(aiCostUsage).where(eq(aiCostUsage.orgId, org.id)));
    expect(usage).toEqual([]);
  });

  it('still reports genuine exhaustion as exhaustion once the spend is settled', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const reserved = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'spender', billingSource: 'platform',
    }));
    if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
    await withDbAccessContext(orgContext(org.id), () => settleAiBudgetReservation({
      orgId: org.id, reservationId: reserved.reservationId,
      actualCostCents: 100, inputTokens: 10, outputTokens: 10,
    }));

    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'after-spend', billingSource: 'platform',
    }))).resolves.toMatchObject({
      kind: 'denied',
      reason: 'daily_budget',
      message: 'Daily AI budget exhausted ($1.00)',
    });
  });

  // -------------------------------------------------------------------------
  // Review B3 — reservations are bounded in time
  // -------------------------------------------------------------------------

  it('ignores a reservation whose window has closed when admitting the next one', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const stranded = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'stranded', billingSource: 'platform',
    }));
    if (stranded.kind !== 'reserved') throw new Error('expected a reservation');

    // Second dispatch is denied while the first still holds the cap.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'blocked', billingSource: 'platform',
    }))).resolves.toMatchObject({ kind: 'denied', reason: 'daily_budget_in_flight' });

    // The process holding it dies. Without the window this org has no AI until
    // the period rolls over — the whole point of B3.
    await withSystemDbAccessContext(() => db
      .update(aiBudgetReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(aiBudgetReservations.id, stranded.reservationId)));

    // Admission is correct BEFORE the sweep relabels anything: the predicate is
    // the time bound, not the status.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'after-window', billingSource: 'platform',
    }))).resolves.toMatchObject({ kind: 'reserved', reservedCostCents: 100 });
  });

  it('sweeps stale reservations to expired with the reason that fired', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const activeRow = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'sweep-active', billingSource: 'platform',
    }));
    if (activeRow.kind !== 'reserved') throw new Error('expected a reservation');
    const indeterminateRow = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'sweep-indeterminate', billingSource: 'platform',
    }));
    // The second is denied (the first holds the cap), so build it directly.
    expect(indeterminateRow.kind).toBe('denied');
    const [second] = await withSystemDbAccessContext(() => db
      .insert(aiBudgetReservations)
      .values({
        orgId: org.id,
        idempotencyKey: 'sweep-indeterminate-row',
        billingSource: 'platform',
        dailyPeriodKey: '2026-09-10',
        monthlyPeriodKey: '2026-09',
        reservedCostCents: '0',
        status: 'indeterminate',
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: aiBudgetReservations.id }));
    if (!second) throw new Error('expected an indeterminate fixture');

    await withSystemDbAccessContext(() => db
      .update(aiBudgetReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(aiBudgetReservations.id, activeRow.reservationId)));

    const expired = await withSystemDbAccessContext(() => sweepExpiredAiBudgetReservations());
    expect(expired).toBeGreaterThanOrEqual(2);

    const swept = await withSystemDbAccessContext(() => db
      .select({
        id: aiBudgetReservations.id,
        status: aiBudgetReservations.status,
        reason: aiBudgetReservations.expiryReason,
        expiredAt: aiBudgetReservations.expiredAt,
      })
      .from(aiBudgetReservations)
      .where(eq(aiBudgetReservations.orgId, org.id)));
    const byId = new Map(swept.map((row) => [row.id, row]));
    // `SET` reads the OLD row, so each row is labelled with the status it left.
    expect(byId.get(activeRow.reservationId)).toMatchObject({ status: 'expired', reason: 'active_ttl' });
    expect(byId.get(second.id)).toMatchObject({ status: 'expired', reason: 'indeterminate_ttl' });
    expect(byId.get(activeRow.reservationId)?.expiredAt).toBeInstanceOf(Date);

    // Idempotent: a second pass has nothing left to claim.
    await expect(withSystemDbAccessContext(() => sweepExpiredAiBudgetReservations())).resolves.toBe(0);
  });

  it('settles a late completion against an expired reservation without double-charging', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const reserved = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'late-settle', billingSource: 'platform',
    }));
    if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
    await withDbAccessContext(orgContext(org.id), () => markAiBudgetReservationIndeterminate({
      orgId: org.id, reservationId: reserved.reservationId,
    }));
    await withSystemDbAccessContext(() => db
      .update(aiBudgetReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(aiBudgetReservations.id, reserved.reservationId)));
    await withSystemDbAccessContext(() => sweepExpiredAiBudgetReservations());

    // The provider finally answers. Expiry only stopped the row HOLDING
    // capacity — real spend must still reach `ai_cost_usage`.
    const settled = await withDbAccessContext(orgContext(org.id), () => settleAiBudgetReservation({
      orgId: org.id, reservationId: reserved.reservationId,
      actualCostCents: 7.5, inputTokens: 5, outputTokens: 5,
    }));
    expect(settled.kind).toBe('settled');

    // Replaying the same settlement is a no-op, not a second charge.
    await expect(withDbAccessContext(orgContext(org.id), () => settleAiBudgetReservation({
      orgId: org.id, reservationId: reserved.reservationId,
      actualCostCents: 7.5, inputTokens: 5, outputTokens: 5,
    }))).resolves.toMatchObject({ kind: 'already_settled' });

    const daily = await withDbAccessContext(orgContext(org.id), () => db
      .select({ total: aiCostUsage.totalCostCents })
      .from(aiCostUsage)
      .where(and(eq(aiCostUsage.orgId, org.id), eq(aiCostUsage.period, 'daily'))));
    expect(daily).toHaveLength(1);
    expect(Number(daily[0]?.total)).toBeCloseTo(7.5, 6);
  });

  it('extends the window when an outcome becomes indeterminate, and reports an already-swept row', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const reserved = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'extend-window', billingSource: 'platform',
    }));
    if (reserved.kind !== 'reserved') throw new Error('expected a reservation');
    const before = await withSystemDbAccessContext(() => db
      .select({ expiresAt: aiBudgetReservations.expiresAt })
      .from(aiBudgetReservations)
      .where(eq(aiBudgetReservations.id, reserved.reservationId)));

    await withDbAccessContext(orgContext(org.id), () => markAiBudgetReservationIndeterminate({
      orgId: org.id, reservationId: reserved.reservationId,
    }));
    const after = await withSystemDbAccessContext(() => db
      .select({ expiresAt: aiBudgetReservations.expiresAt })
      .from(aiBudgetReservations)
      .where(eq(aiBudgetReservations.id, reserved.reservationId)));
    // An unknown outcome may still settle late, so it keeps its claim for far
    // longer than an active dispatch — but still not forever.
    expect(after[0]!.expiresAt.getTime()).toBeGreaterThan(before[0]!.expiresAt.getTime());

    await withSystemDbAccessContext(() => db
      .update(aiBudgetReservations)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(aiBudgetReservations.id, reserved.reservationId)));
    await withSystemDbAccessContext(() => sweepExpiredAiBudgetReservations());

    // Re-marking a swept row must not silently reclaim capacity it no longer
    // holds; it reports what happened instead.
    await expect(withDbAccessContext(orgContext(org.id), () => markAiBudgetReservationIndeterminate({
      orgId: org.id, reservationId: reserved.reservationId,
    }))).resolves.toMatchObject({ kind: 'already_expired' });
    await expect(withDbAccessContext(orgContext(org.id), () => releaseUnusedAiBudgetReservation({
      orgId: org.id, reservationId: reserved.reservationId,
    }))).resolves.toMatchObject({ kind: 'already_expired' });
  });

  // -------------------------------------------------------------------------
  // Review S8 — what the unique idempotency index actually guarantees
  // -------------------------------------------------------------------------

  it('refuses to reuse one idempotency key for a different dispatch', async () => {
    const org = await makeOrgWithBudget(null, null);
    const [session] = await withDbAccessContext(orgContext(org.id), () =>
      db.insert(aiSessions).values({ orgId: org.id }).returning({ id: aiSessions.id }));
    if (!session) throw new Error('expected a session fixture');

    await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'shared-key', billingSource: 'platform',
    }));

    // Same key, different billing source — the caller is describing a DIFFERENT
    // dispatch, so rejoining the existing reservation would mis-attribute it.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'shared-key', billingSource: 'partner_key',
    }))).rejects.toThrow(/conflicts with another dispatch/i);

    // Same key, different session — likewise.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'shared-key', billingSource: 'platform', sessionId: session.id,
    }))).rejects.toThrow(/conflicts with another dispatch/i);
  });

  it('refuses a replay of a key whose reservation already reached a terminal state', async () => {
    const org = await makeOrgWithBudget(null, null);
    const reserved = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'terminal-key', billingSource: 'platform',
    }));
    if (reserved.kind === 'denied') throw new Error('expected a reservation');
    await withDbAccessContext(orgContext(org.id), () => settleAiBudgetReservation({
      orgId: org.id, reservationId: reserved.reservationId,
      actualCostCents: 1, inputTokens: 1, outputTokens: 1,
    }));

    // A settled key cannot be re-admitted. The alternative — silently minting a
    // second reservation — is how one dispatch would spend twice.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'terminal-key', billingSource: 'platform',
    }))).rejects.toThrow(/already settled/i);

    const released = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'released-key', billingSource: 'platform',
    }));
    if (released.kind === 'denied') throw new Error('expected a reservation');
    await withDbAccessContext(orgContext(org.id), () => releaseUnusedAiBudgetReservation({
      orgId: org.id, reservationId: released.reservationId,
    }));
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'released-key', billingSource: 'platform',
    }))).rejects.toThrow(/already released/i);
  });

  // -------------------------------------------------------------------------
  // Review S9a — the arithmetic admission actually performs
  // -------------------------------------------------------------------------

  it('reserves the MONTHLY remainder when monthly is the tighter cap', async () => {
    // Daily 10000c, monthly 250c, 200c of monthly already settled. Only
    // Math.min(dailyRemaining, monthlyRemaining) gives 50 — using
    // dailyRemaining alone reserves 10000 and lets one call overrun the month.
    const org = await makeOrgWithBudget(10_000, 250);
    await withSystemDbAccessContext(() => db.insert(aiCostUsage).values({
      orgId: org.id, period: 'monthly', periodKey: '2026-09', totalCostCents: 200,
    }));

    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'monthly-binding',
      billingSource: 'platform',
      now: new Date('2026-09-10T12:00:00.000Z'),
    }))).resolves.toMatchObject({ kind: 'reserved', reservedCostCents: 50 });
  });

  it('denies on the monthly cap when only the month is exhausted', async () => {
    const org = await makeOrgWithBudget(10_000, 250);
    await withSystemDbAccessContext(() => db.insert(aiCostUsage).values({
      orgId: org.id, period: 'monthly', periodKey: '2026-09', totalCostCents: 250,
    }));

    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'monthly-exhausted',
      billingSource: 'platform',
      now: new Date('2026-09-10T12:00:00.000Z'),
    }))).resolves.toMatchObject({
      kind: 'denied',
      reason: 'monthly_budget',
      message: 'Monthly AI budget exhausted ($2.50)',
    });
  });

  it('denies with ai_disabled when the organization has AI switched off', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await withDbAccessContext(orgContext(org.id), () => db.insert(aiBudgets).values({
      orgId: org.id, enabled: false, dailyBudgetCents: null, monthlyBudgetCents: null,
    }));

    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id, idempotencyKey: 'ai-off', billingSource: 'platform',
    }))).resolves.toMatchObject({
      kind: 'denied',
      reason: 'ai_disabled',
      message: 'AI features are disabled for this organization',
    });
  });

  it('clamps a negative legacy aggregate to zero instead of manufacturing capacity', async () => {
    const org = await makeOrgWithBudget(100, 500);
    // A malformed pre-fence float4 total. Subtracting it would hand out 150c
    // against a 100c cap.
    await withSystemDbAccessContext(() => db.insert(aiCostUsage).values({
      orgId: org.id, period: 'daily', periodKey: '2026-09-10', totalCostCents: -50,
    }));

    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'negative-legacy',
      billingSource: 'platform',
      now: new Date('2026-09-10T12:00:00.000Z'),
    }))).resolves.toMatchObject({ kind: 'reserved', reservedCostCents: 100 });
  });

  it('rolls the period keys over at UTC midnight and month end', async () => {
    const org = await makeOrgWithBudget(100, 500);
    const september = await withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'sept-last-minute',
      billingSource: 'platform',
      now: new Date('2026-09-30T23:59:59.000Z'),
    }));
    expect(september).toMatchObject({
      kind: 'reserved', dailyPeriodKey: '2026-09-30', monthlyPeriodKey: '2026-09',
    });

    // A new day AND a new month: September's hold is scoped to September's
    // keys, so it cannot deny October.
    await expect(withDbAccessContext(orgContext(org.id), () => reserveAiBudget({
      orgId: org.id,
      idempotencyKey: 'oct-first-minute',
      billingSource: 'platform',
      now: new Date('2026-10-01T00:00:01.000Z'),
    }))).resolves.toMatchObject({
      kind: 'reserved', dailyPeriodKey: '2026-10-01', monthlyPeriodKey: '2026-10',
    });
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
