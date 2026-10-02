/** W10 (#7608) Task 8: the monthly close is exactly-once, late-safe and rounds once. */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { ChargeRunConflictError, runOrgChargePeriod } from '../../services/aiChargeback/chargeRun';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);
const NOW = new Date('2026-12-02T06:00:00Z'); // November is closed
const run = (orgId: string, periodStart = '2026-11-01', now = NOW) =>
  withSystemDbAccessContext(() => runOrgChargePeriod({ orgId, periodStart, now }));

async function fixture(currencyCode = 'USD') {
  const p = await createPartner({ currencyCode });
  const o = await createOrganization({ partnerId: p.id, currencyCode });
  const card = await seedAiCard(p.id, { currencyCode });
  return { partnerId: p.id, orgId: o.id, card };
}
async function charges(orgId: string) {
  return fixtureSql`SELECT period_start::text, usage_period_start::text, currency_code, served_model, priced,
    invocation_count, amount_exact::text, amount::text, billing_status FROM ai_usage_charges
    WHERE org_id = ${orgId} ORDER BY usage_period_start, served_model, priced`;
}
async function claimCount(orgId: string) {
  const [r] = await fixtureSql`SELECT count(*)::int AS n FROM ai_usage_charge_claims WHERE org_id = ${orgId}`;
  return r!.n as number;
}
async function runCount(orgId: string) {
  const [r] = await fixtureSql`SELECT count(*)::int AS n FROM ai_usage_charge_runs WHERE org_id = ${orgId}`;
  return r!.n as number;
}

/** A competing session opened as the superuser (no RLS) with one connection. */
function openHolder() {
  return postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });
}

/**
 * Readiness barrier for the racer: resolves once some backend is waiting on a
 * lock HELD BY `holderPid` (pg_blocking_pids), i.e. the racer has reached the
 * contended statement. Polls the catalog; never sleeps to "give it time".
 */
async function waitUntilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_catalog.pg_blocking_pids(pid))`);
    if ((rows[0]?.waiting ?? 0) >= 1) return;
    if (Date.now() > deadline) throw new Error(`no backend became blocked by holder pid ${holderPid}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.runIf(RUN)('runOrgChargePeriod (#7608)', () => {
  it('runs as breeze_app, which holds TEMP (precondition P10 for the frozen candidate set)', async () => {
    const [who] = await withSystemDbAccessContext(async () => (await db.execute(sql`
      SELECT current_user AS u, has_database_privilege(current_user, current_database(), 'TEMP') AS temp`)) as unknown as Array<{ u: string; temp: boolean }>);
    expect(who).toEqual({ u: 'breeze_app', temp: true });
  });

  it('refuses to run outside a system DB context', async () => {
    await expect(runOrgChargePeriod({ orgId: randomUUID(), periodStart: '2026-11-01', now: NOW }))
      .rejects.toThrow(/system DB context/);
  });

  it('skips an unknown org', async () => {
    expect(await run(randomUUID())).toEqual({ kind: 'skipped', reason: 'org_not_found' });
  });

  it('closes a month into one charge per (usage month, currency, model, priced) and claims every row', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-03T10:00:00Z', amount: '1.250000' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-30T23:59:59Z', amount: '0.333333' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-10T00:00:00Z', amount: '2.000000', servedModel: 'w10-test-other' });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', chargeCount: 2, invocationCount: 3, lateInvocationCount: 0 });
    expect(await charges(f.orgId)).toEqual([
      expect.objectContaining({ served_model: 'w10-test-model', invocation_count: 2, amount_exact: '1.583333', amount: '1.58', billing_status: 'not_billed' }),
      expect.objectContaining({ served_model: 'w10-test-other', invocation_count: 1, amount_exact: '2.000000', amount: '2.00' }),
    ]);
    expect(await claimCount(f.orgId)).toBe(3);
    const [r] = await fixtureSql`SELECT invocation_count, charge_count, unpriced_invocation_count, late_invocation_count,
      completed_at IS NOT NULL AS completed FROM ai_usage_charge_runs WHERE org_id = ${f.orgId}`;
    expect(r).toMatchObject({ invocation_count: 3, charge_count: 2, unpriced_invocation_count: 0, late_invocation_count: 0, completed: true });
  });

  it('amount_exact equals the exact sum; rounds once per charge (RR3/RR4); two models round independently (RR6)', async () => {
    const f = await fixture();
    for (const amount of ['0.005000', '0.005000', '0.005000']) {
      await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount });
    }
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount: '0.005000', servedModel: 'w10-test-other' });
    await run(f.orgId);
    const rows = await charges(f.orgId);
    expect(rows[0]).toMatchObject({ amount_exact: '0.015000', amount: '0.02' }); // 0.015 → half-up → 0.02 (never 3 × round(0.005))
    expect(rows[1]).toMatchObject({ amount_exact: '0.005000', amount: '0.01' }); // 0.005 → 0.01
    // RR6: the two rounded rows sum to 0.03 while the month's exact total 0.020000
    // rounds to 0.02 — the declared ≤ ½-minor-unit-per-row drift, by design.
    const [sums] = await fixtureSql`SELECT sum(amount)::text AS rounded, sum(amount_exact)::text AS exact
      FROM ai_usage_charges WHERE org_id = ${f.orgId}`;
    expect(sums).toEqual({ rounded: '0.03', exact: '0.020000' });
  });

  it('a priced charge that rounds to zero is no_charge, never a $0 line (RR4)', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount: '0.004000' });
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ amount_exact: '0.004000', amount: '0.00', billing_status: 'no_charge' })]);
    expect(await claimCount(f.orgId)).toBe(1); // claimed: it can never be re-billed later
  });

  it('JPY rounds to whole yen', async () => {
    const f = await fixture('JPY');
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', currency: 'JPY', amount: '1000.500000' });
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ currency_code: 'JPY', amount: '1001.00' })]);
  });

  it('JPY under half a yen is no_charge', async () => {
    const f = await fixture('JPY');
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', currency: 'JPY', amount: '0.499999' });
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ currency_code: 'JPY', amount: '0.00', billing_status: 'no_charge' })]);
  });

  it('unpriced usage becomes an unpriced charge (claimed, never billable, counted on the run)', async () => {
    const f = await fixture('EUR');
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', currency: 'EUR', amount: null });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', unpricedInvocationCount: 1 });
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ priced: false, amount: null, billing_status: 'unpriced' })]);
  });

  it('re-run of a closed period is a no-op', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    await run(f.orgId);
    expect(await run(f.orgId)).toEqual({ kind: 'skipped', reason: 'already_run' });
    expect(await charges(f.orgId)).toHaveLength(1);
    expect(await claimCount(f.orgId)).toBe(1);
    expect(await runCount(f.orgId)).toBe(1);
  });

  it('an open period is refused (closes only an hour after the UTC month ends)', async () => {
    const f = await fixture();
    expect(await run(f.orgId, '2026-11-01', new Date('2026-12-01T00:30:00Z'))).toEqual({ kind: 'skipped', reason: 'period_open' });
    expect(await runCount(f.orgId)).toBe(0);
  });

  it('only rows written before the UTC month end bill in that month', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-30T23:59:59.999Z' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-12-01T00:00:00Z' });
    await run(f.orgId);
    expect(await claimCount(f.orgId)).toBe(1);
  });

  it('month boundaries are UTC instants whatever the session TimeZone', async () => {
    const f = await fixture();
    // In America/Los_Angeles these are 31 Oct 20:00, 30 Nov 15:59 and 30 Nov 19:00
    // local. A bare-date boundary cast or a session-zone date_trunc would label the
    // first October and pull the third into November.
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-01T03:00:00Z' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-30T23:59:59Z' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-12-01T03:00:00Z' });
    const result = await withSystemDbAccessContext(async () => {
      await db.execute(sql`SET LOCAL TimeZone = 'America/Los_Angeles'`);
      return runOrgChargePeriod({ orgId: f.orgId, periodStart: '2026-11-01', now: NOW });
    });
    expect(result).toMatchObject({ kind: 'charged', invocationCount: 2, lateInvocationCount: 0, chargeCount: 1 });
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ usage_period_start: '2026-11-01', invocation_count: 2 })]);
  });

  it('replayed settlement bills in the replay month (the ledger-write rule)', async () => {
    const f = await fixture();
    // A turn at 23:58 on 30 Nov whose deferred settlement replayed at 00:03 on 1 Dec is
    // written with created_at = 00:03 1 Dec (Task 6; W03 P5) — it belongs to December
    // (decided 2026-10-02, #7598).
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-12-01T00:03:00Z' });
    await run(f.orgId);
    expect(await claimCount(f.orgId)).toBe(0);
    const dec = await run(f.orgId, '2026-12-01', new Date('2027-01-01T02:00:00Z'));
    expect(dec).toMatchObject({ kind: 'charged', invocationCount: 1, lateInvocationCount: 0 });
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ period_start: '2026-12-01', usage_period_start: '2026-12-01' })]);
  });

  it('straggler from a closed month is carried into the next run, labelled', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    await run(f.orgId);
    // A November row that appears after November closed (e.g. moved in by an org merge).
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-20T00:00:00Z', amount: '3.000000' });
    // And ordinary December usage, which must stay a separate charge row.
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-12-10T00:00:00Z', amount: '0.500000' });
    const dec = await run(f.orgId, '2026-12-01', new Date('2027-01-01T02:00:00Z'));
    expect(dec).toMatchObject({ kind: 'charged', invocationCount: 2, lateInvocationCount: 1, chargeCount: 2 });
    const decRows = (await charges(f.orgId)).filter((c) => c.period_start === '2026-12-01');
    expect(decRows).toEqual([
      expect.objectContaining({ usage_period_start: '2026-11-01', amount: '3.00', billing_status: 'not_billed' }),
      expect.objectContaining({ usage_period_start: '2026-12-01', amount: '0.50', billing_status: 'not_billed' }),
    ]);
    expect(await claimCount(f.orgId)).toBe(3);
  });

  it('beyond lookback is skipped and counted', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-07-31T23:59:59Z' }); // > 92 days before 1 Nov
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', invocationCount: 1, expiredInvocationCount: 1 });
    expect(await claimCount(f.orgId)).toBe(1);
  });

  it('the lookback start (UTC midnight 92 days back) is inclusive: that row is a labelled straggler', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-08-01T00:00:00Z' });
    const result = await run(f.orgId);
    expect(result).toMatchObject({ kind: 'charged', invocationCount: 1, lateInvocationCount: 1, expiredInvocationCount: 0 });
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ period_start: '2026-11-01', usage_period_start: '2026-08-01' })]);
  });

  it('close uses stamped amounts, not the current card', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z', amount: '4.000000' });
    await fixtureSql`UPDATE billing_profiles SET ai_coverage = 'non_billable', ai_markup_percent = NULL WHERE id = ${f.card}`;
    await run(f.orgId);
    expect(await charges(f.orgId)).toEqual([expect.objectContaining({ amount: '4.00', billing_status: 'not_billed' })]);
  });

  it('non-chargeable and shadow rows are never claimed', async () => {
    const f = await fixture();
    await fixtureSql`INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents, created_at)
      VALUES (${f.orgId}, 'chat', 'platform', 'w10-test-model', 'w10-test-model', 'shadow', '{}'::jsonb, 1, '2026-11-05T00:00:00Z'),
             (${f.orgId}, 'chat', 'platform', 'w10-test-model', 'w10-test-model', 'authoritative', '{}'::jsonb, 1, '2026-11-05T00:00:00Z')`;
    expect(await run(f.orgId)).toMatchObject({ kind: 'charged', invocationCount: 0, chargeCount: 0 });
    expect(await claimCount(f.orgId)).toBe(0);
  });

  it('another org\'s usage is never claimed into this org\'s close', async () => {
    const f = await fixture();
    const other = await createOrganization({ partnerId: f.partnerId });
    await seedChargeableInvocation({ orgId: other.id, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    expect(await run(f.orgId)).toMatchObject({ kind: 'charged', invocationCount: 1 });
    expect(await claimCount(other.id)).toBe(0);
  });

  it('never takes the organizations row lock: closes while another session holds FOR NO KEY UPDATE on the org', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    // FOR NO KEY UPDATE conflicts with FOR UPDATE / FOR NO KEY UPDATE / FOR SHARE
    // but not with the FOR KEY SHARE every FK check takes, so the close completes
    // only if it takes no explicit org row lock of its own.
    const holder = openHolder();
    let release!: () => void;
    const go = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    const held = holder.begin(async (t) => {
      await t`SELECT id FROM organizations WHERE id = ${f.orgId} FOR NO KEY UPDATE`;
      locked(); // readiness barrier: the row lock is held before the close starts
      await go;
    });
    await holding;
    try {
      const result = await withSystemDbAccessContext(async () => {
        // A regression would wait on the holder: fail fast (55P03) instead of hanging.
        await db.execute(sql`SET LOCAL lock_timeout = '3s'`);
        return runOrgChargePeriod({ orgId: f.orgId, periodStart: '2026-11-01', now: NOW });
      });
      expect(result).toMatchObject({ kind: 'charged', invocationCount: 1 });
    } finally {
      release();
      await held;
      await holder.end();
    }
  }, 30_000);

  it('two concurrent runs: one charges, one skips already_run (no sleeps; lock-held harness)', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    // A competing closer holds the (org, month) run slot uncommitted.
    const holder = openHolder();
    let release!: (commit: boolean) => void;
    const decided = new Promise<boolean>((r) => { release = r; });
    let inserted!: (pid: number) => void;
    const holding = new Promise<number>((r) => { inserted = r; });
    const held = holder.begin(async (t) => {
      const [me] = await t`SELECT pg_backend_pid() AS pid`;
      await t`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
        VALUES (${f.orgId}, ${f.partnerId}, '2026-11-01', '2026-12-01')`;
      inserted(Number(me!.pid)); // readiness barrier: the slot is held BEFORE the racer starts (finding 9)
      if (!(await decided)) throw new Error('rollback');
    }).catch(() => undefined);
    const holderPid = await holding;
    const racer = run(f.orgId);
    await waitUntilBlockedBy(holderPid); // the racer is parked on the holder's unique slot
    release(true); // the holder commits: the racer must see the conflict
    await held;
    expect(await racer).toEqual({ kind: 'skipped', reason: 'already_run' });
    expect(await claimCount(f.orgId)).toBe(0); // the holder claimed nothing; nothing was double-claimed
    expect(await runCount(f.orgId)).toBe(1);
    await holder.end();
  }, 30_000);

  it('a competing closer that rolls back frees the slot: the parked racer closes the month', async () => {
    const f = await fixture();
    await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    const holder = openHolder();
    let release!: (commit: boolean) => void;
    const decided = new Promise<boolean>((r) => { release = r; });
    let inserted!: (pid: number) => void;
    const holding = new Promise<number>((r) => { inserted = r; });
    const held = holder.begin(async (t) => {
      const [me] = await t`SELECT pg_backend_pid() AS pid`;
      await t`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
        VALUES (${f.orgId}, ${f.partnerId}, '2026-11-01', '2026-12-01')`;
      inserted(Number(me!.pid));
      if (!(await decided)) throw new Error('rollback');
    }).catch(() => undefined);
    const holderPid = await holding;
    const racer = run(f.orgId);
    await waitUntilBlockedBy(holderPid);
    release(false); // the holder rolls back: a rolled-back run leaves nothing behind
    await held;
    expect(await racer).toMatchObject({ kind: 'charged', invocationCount: 1 });
    expect(await claimCount(f.orgId)).toBe(1);
    expect(await runCount(f.orgId)).toBe(1);
    await holder.end();
  }, 30_000);

  it('two real closers at once: exactly one closes, every invocation claimed once', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) {
      await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    }
    const results = await Promise.all([run(f.orgId), run(f.orgId)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['charged', 'skipped']);
    expect(results.find((r) => r.kind === 'skipped')).toEqual({ kind: 'skipped', reason: 'already_run' });
    expect(await claimCount(f.orgId)).toBe(5);
    expect(await runCount(f.orgId)).toBe(1);
    const [dupes] = await fixtureSql`SELECT count(*)::int AS n FROM (SELECT invocation_id FROM ai_usage_charge_claims
      WHERE org_id = ${f.orgId} GROUP BY invocation_id HAVING count(*) > 1) d`;
    expect(dupes!.n).toBe(0);
  }, 30_000);

  it('a conflicting claim rolls the whole run back (no run row, no charges)', async () => {
    const f = await fixture();
    const inv = await seedChargeableInvocation({ orgId: f.orgId, cardId: f.card, createdAt: '2026-11-05T00:00:00Z' });
    const [stray] = await fixtureSql`INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
      currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
      VALUES (${f.orgId}, ${f.partnerId}, gen_random_uuid(), '2026-10-01', '2026-11-01', '2026-10-01', 'USD', 'x', 'x', true, 1, 1, 1, 'billed')
      RETURNING id`;
    // Another closer claims the invocation uncommitted, AFTER our aggregate would see it.
    const holder = openHolder();
    let release!: () => void;
    const go = new Promise<void>((r) => { release = r; });
    let inserted!: (pid: number) => void;
    const holding = new Promise<number>((r) => { inserted = r; });
    const held = holder.begin(async (t) => {
      const [me] = await t`SELECT pg_backend_pid() AS pid`;
      await t`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
        VALUES (${inv}, ${f.orgId}, gen_random_uuid(), ${stray!.id})`;
      inserted(Number(me!.pid)); // readiness barrier (finding 9)
      await go;
    });
    const holderPid = await holding;
    const racer = run(f.orgId);
    racer.catch(() => undefined); // asserted below; keep the pending rejection handled
    await waitUntilBlockedBy(holderPid); // the racer's claim INSERT waits on the holder's PK slot
    release();
    await held;
    await expect(racer).rejects.toBeInstanceOf(ChargeRunConflictError);
    expect(await runCount(f.orgId)).toBe(0);
    expect((await charges(f.orgId)).filter((c) => c.period_start === '2026-11-01')).toHaveLength(0);
    // The holder's claim stands; the invocation is claimed exactly once.
    expect(await claimCount(f.orgId)).toBe(1);
    await holder.end();
  }, 30_000);
});
