/**
 * device_reattach_intents + device_reattachments — RLS as breeze_app (#8318
 * wave 1b, spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §4.3, §4.4). Migrations under test: 2027-01-06-120100-device-reattach-intents.sql
 * and 2027-01-06-120200-device-reattachments.sql.
 *
 * Both tables are partner-axis (shape 3) and narrowed by a RESTRICTIVE
 * org-access policy over (target_org_id, source_org_id, source_parked). The
 * four checks §4.3 asks for:
 *   1. a technician limited to selected orgs reads 0 rows of an intent whose
 *      target org, or real source org, they lack (and reads the ones they
 *      have, a parked source included);
 *   2. forging one fails with 42501;
 *   3. writing source_parked = true for a real org is overwritten by the
 *      trigger, then refused;
 *   4. a cross-partner row is refused (another partner's id: 42501; orgs of
 *      another partner, even in system scope: the trigger's 23514).
 * Plus the guards the protocol leans on: the authorized identity is
 * immutable, an ended intent is terminal, the per-state shape CHECK; and for
 * the ledger: writes are system-only, reads follow the same org floor, UPDATE
 * is blocked even in system scope, DELETE works in system scope.
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/deviceReattachIntentsRls.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { deviceReattachIntents, deviceReattachments } from '../../db/schema';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

async function cause(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (err) {
    const e = err as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    return e.cause ?? e;
  }
}

async function seedPartnerWithOrgs() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const pool = await seedHoldingOrg(partner.id);
  /** A technician limited to org A. */
  const techA: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [partner.id],
  };
  /** A full partner admin: every org of the partner. */
  const admin: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id, orgB.id], accessiblePartnerIds: [partner.id],
  };
  return { partner, orgA, orgB, siteA, siteB, pool, techA, admin };
}
type Seeded = Awaited<ReturnType<typeof seedPartnerWithOrgs>>;

async function devicePair(source: { orgId: string; siteId: string; parked?: boolean }, target: { orgId: string; siteId: string }) {
  const src = source.parked
    ? await seedParkedDevice(source.orgId, source.siteId)
    : await createDevice({ orgId: source.orgId, siteId: source.siteId });
  const tgt = await createDevice({ orgId: target.orgId, siteId: target.siteId });
  return { sourceDeviceId: src.id, targetDeviceId: tgt.id };
}

function intentValues(input: {
  partnerId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourceOrgId: string;
  targetOrgId: string;
  sourceParked?: boolean;
}) {
  return {
    partnerId: input.partnerId,
    sourceDeviceId: input.sourceDeviceId,
    targetDeviceId: input.targetDeviceId,
    state: 'requested' as const,
    evidenceLevel: 'hint' as const,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    sourceAgentId: `src-${randomUUID()}`.slice(0, 64),
    sourceOrgId: input.sourceOrgId,
    ...(input.sourceParked !== undefined ? { sourceParked: input.sourceParked } : {}),
    targetAgentId: `tgt-${randomUUID()}`.slice(0, 64),
    targetIncarnation: 1,
    targetOrgId: input.targetOrgId,
  };
}

async function insertIntentAsSystem(values: ReturnType<typeof intentValues>) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(deviceReattachIntents).values(values).returning());
  return row!;
}

/** Three intents: target A + source A; target B + source A; target A + source B; target A + parked source. */
async function seedIntents(s: Seeded) {
  const aa = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
  const ab = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgB.id, siteId: s.siteB.id });
  const ba = await devicePair({ orgId: s.orgB.id, siteId: s.siteB.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
  const pa = await devicePair({ orgId: s.pool.orgId, siteId: s.pool.siteId, parked: true }, { orgId: s.orgA.id, siteId: s.siteA.id });
  const base = { partnerId: s.partner.id };
  return {
    ownBoth: await insertIntentAsSystem(intentValues({ ...base, ...aa, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id })),
    foreignTarget: await insertIntentAsSystem(intentValues({ ...base, ...ab, sourceOrgId: s.orgA.id, targetOrgId: s.orgB.id })),
    foreignSource: await insertIntentAsSystem(intentValues({ ...base, ...ba, sourceOrgId: s.orgB.id, targetOrgId: s.orgA.id })),
    parkedSource: await insertIntentAsSystem(intentValues({ ...base, ...pa, sourceOrgId: s.pool.orgId, targetOrgId: s.orgA.id })),
  };
}

const visibleIntentIds = (ctx: DbAccessContext, ids: string[]) =>
  withDbAccessContext(ctx, () => db.select({ id: deviceReattachIntents.id }).from(deviceReattachIntents))
    .then((rows) => rows.map((r) => r.id).filter((id) => ids.includes(id)).sort());

describe('device_reattach_intents RLS (breeze_app)', () => {
  it('derives source_parked from the source org: true for the holding org, false for a real org', async () => {
    const s = await seedPartnerWithOrgs();
    const intents = await seedIntents(s);
    expect(intents.parkedSource.sourceParked).toBe(true);
    expect(intents.ownBoth.sourceParked).toBe(false);
  });

  it('(1) a technician limited to selected orgs reads only intents whose target org, and real source org, are theirs', async () => {
    const s = await seedPartnerWithOrgs();
    const intents = await seedIntents(s);
    const all = Object.values(intents).map((i) => i.id);

    expect(await visibleIntentIds(s.techA, all)).toEqual([intents.ownBoth.id, intents.parkedSource.id].sort());
    // A full partner admin sees all four; system scope too.
    expect(await visibleIntentIds(s.admin, all)).toEqual([...all].sort());
    const system = await withSystemDbAccessContext(() => db.select({ id: deviceReattachIntents.id }).from(deviceReattachIntents));
    expect(system.map((r) => r.id).filter((id) => all.includes(id)).sort()).toEqual([...all].sort());
    // Another partner's admin sees none of them.
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const otherCtx: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [otherOrg.id], accessiblePartnerIds: [other.id] };
    expect(await visibleIntentIds(otherCtx, all)).toEqual([]);
  });

  it('(1) a technician can neither update nor delete an intent they cannot see', async () => {
    const s = await seedPartnerWithOrgs();
    const intents = await seedIntents(s);
    const updated = await withDbAccessContext(s.techA, () => db.update(deviceReattachIntents)
      .set({ state: 'cancelled', cancelReason: 'admin' })
      .where(eq(deviceReattachIntents.id, intents.foreignTarget.id))
      .returning({ id: deviceReattachIntents.id }));
    expect(updated).toEqual([]);
    const deleted = await withDbAccessContext(s.techA, () => db.delete(deviceReattachIntents)
      .where(eq(deviceReattachIntents.id, intents.foreignSource.id))
      .returning({ id: deviceReattachIntents.id }));
    expect(deleted).toEqual([]);
    const [still] = await getTestDb().select({ state: deviceReattachIntents.state }).from(deviceReattachIntents)
      .where(eq(deviceReattachIntents.id, intents.foreignTarget.id));
    expect(still?.state).toBe('requested');
  });

  it('(2) forging an intent whose target org the technician lacks fails with 42501', async () => {
    const s = await seedPartnerWithOrgs();
    const pair = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgB.id, siteId: s.siteB.id });
    const c = await cause(() => withDbAccessContext(s.techA, () => db.insert(deviceReattachIntents)
      .values(intentValues({ partnerId: s.partner.id, ...pair, sourceOrgId: s.orgA.id, targetOrgId: s.orgB.id }))));
    expect(c?.code).toBe('42501');
    expect(c?.message).toMatch(/row-level security policy "device_reattach_intents_org_access"/);
  });

  it('(3) source_parked = true written for a real org is overwritten by the trigger, then refused', async () => {
    const s = await seedPartnerWithOrgs();
    const pair = await devicePair({ orgId: s.orgB.id, siteId: s.siteB.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
    const values = intentValues({ partnerId: s.partner.id, ...pair, sourceOrgId: s.orgB.id, targetOrgId: s.orgA.id, sourceParked: true });
    // The technician has the target org but not the real source org: the
    // forged flag would have passed the floor; the trigger resets it first.
    const c = await cause(() => withDbAccessContext(s.techA, () => db.insert(deviceReattachIntents).values(values)));
    expect(c?.code).toBe('42501');

    // In system scope the same write lands, with the flag derived (false).
    const row = await insertIntentAsSystem(values);
    expect(row.sourceParked).toBe(false);
    // An UPDATE that sets it to true is overwritten too.
    await withSystemDbAccessContext(() => db.update(deviceReattachIntents)
      .set({ sourceParked: true }).where(eq(deviceReattachIntents.id, row.id)));
    const [after] = await getTestDb().select({ sourceParked: deviceReattachIntents.sourceParked })
      .from(deviceReattachIntents).where(eq(deviceReattachIntents.id, row.id));
    expect(after?.sourceParked).toBe(false);
  });

  it('a technician may create an intent whose target org and real source org are theirs', async () => {
    const s = await seedPartnerWithOrgs();
    const pair = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
    const rows = await withDbAccessContext(s.techA, () => db.insert(deviceReattachIntents)
      .values(intentValues({ partnerId: s.partner.id, ...pair, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id }))
      .returning({ id: deviceReattachIntents.id }));
    expect(rows).toHaveLength(1);
  });

  it('(4) refuses a cross-partner row: another partner\'s id (42501), and orgs of another partner even in system scope (23514)', async () => {
    const s = await seedPartnerWithOrgs();
    const other = await seedPartnerWithOrgs();
    const pair = await devicePair({ orgId: other.orgA.id, siteId: other.siteA.id }, { orgId: other.orgA.id, siteId: other.siteA.id });
    // Partner A's admin forging a row for partner B.
    const forged = await cause(() => withDbAccessContext(s.admin, () => db.insert(deviceReattachIntents)
      .values(intentValues({ partnerId: other.partner.id, ...pair, sourceOrgId: other.orgA.id, targetOrgId: other.orgA.id }))));
    expect(forged?.code).toBe('42501');

    // System scope: partner A's id over partner B's orgs → the trigger refuses.
    const mismatched = await cause(() => insertIntentAsSystem(
      intentValues({ partnerId: s.partner.id, ...pair, sourceOrgId: other.orgA.id, targetOrgId: other.orgA.id })));
    expect(mismatched?.code).toBe('23514');
    expect(mismatched?.message).toMatch(/must both belong to the intent's partner/);

    // One org of each partner is refused as well.
    const pairMixed = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: other.orgA.id, siteId: other.siteA.id });
    const mixed = await cause(() => insertIntentAsSystem(
      intentValues({ partnerId: s.partner.id, ...pairMixed, sourceOrgId: s.orgA.id, targetOrgId: other.orgA.id })));
    expect(mixed?.code).toBe('23514');
  });

  it('the authorized identity of an intent never changes, and an ended intent is terminal (even in system scope)', async () => {
    const s = await seedPartnerWithOrgs();
    const intents = await seedIntents(s);
    const moved = await cause(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE device_reattach_intents SET target_incarnation = 2 WHERE id = ${intents.ownBoth.id}::uuid`)));
    expect(moved?.code).toBe('42501');
    expect(moved?.message).toMatch(/authorized identity of an intent never changes/);

    await withSystemDbAccessContext(() => db.update(deviceReattachIntents)
      .set({ state: 'cancelled', cancelReason: 'admin' })
      .where(eq(deviceReattachIntents.id, intents.ownBoth.id)));
    const reopened = await cause(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE device_reattach_intents SET state = 'requested', cancel_reason = NULL WHERE id = ${intents.ownBoth.id}::uuid`)));
    expect(reopened?.code).toBe('42501');
    expect(reopened?.message).toMatch(/cancelled intent is terminal/);
  });

  it.each([
    ['requested with a staged set', { stagedAgentId: 'x'.repeat(64) }],
    ['staged without hashes', { state: 'staged', stagedAgentId: 'x'.repeat(64), stagedAt: new Date() }],
    ['cancelled without a reason', { state: 'cancelled' }],
    ['a reason on a live intent', { cancelReason: 'admin' }],
    ['a malformed hash', { state: 'cancelled', cancelReason: 'admin', confirmationTokenHash: 'not-hex' }],
    ['an unknown evidence level', { evidenceLevel: 'guess' }],
  ])('the shape CHECKs refuse %s', async (_label, patch) => {
    const s = await seedPartnerWithOrgs();
    const pair = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
    const c = await cause(() => insertIntentAsSystem({
      ...intentValues({ partnerId: s.partner.id, ...pair, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id }),
      ...(patch as object),
    } as ReturnType<typeof intentValues>));
    expect(c?.code).toBe('23514');
  });

  it('allows one open intent per device per role (the partial unique indexes)', async () => {
    const s = await seedPartnerWithOrgs();
    const pair = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
    const other = await createDevice({ orgId: s.orgA.id, siteId: s.siteA.id });
    const first = await insertIntentAsSystem(intentValues({ partnerId: s.partner.id, ...pair, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id }));
    const sameTarget = await cause(() => insertIntentAsSystem(intentValues({
      partnerId: s.partner.id, sourceDeviceId: other.id, targetDeviceId: pair.targetDeviceId, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id,
    })));
    expect(sameTarget?.code).toBe('23505');
    // Once the first one ends, the target may be named again.
    await withSystemDbAccessContext(() => db.update(deviceReattachIntents)
      .set({ state: 'expired' }).where(eq(deviceReattachIntents.id, first.id)));
    const again = await insertIntentAsSystem(intentValues({
      partnerId: s.partner.id, sourceDeviceId: other.id, targetDeviceId: pair.targetDeviceId, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id,
    }));
    expect(again.state).toBe('requested');
  });

  it('one confirmation token, one intent: the partial unique index refuses a second intent bearing the same hash', async () => {
    const s = await seedPartnerWithOrgs();
    const hash = 'e'.repeat(64);
    const cancelledWith = { state: 'cancelled' as const, cancelReason: 'admin', confirmationTokenHash: hash };
    const one = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
    await insertIntentAsSystem({ ...intentValues({ partnerId: s.partner.id, ...one, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id }), ...cancelledWith } as unknown as ReturnType<typeof intentValues>);
    const two = await devicePair({ orgId: s.orgA.id, siteId: s.siteA.id }, { orgId: s.orgA.id, siteId: s.siteA.id });
    const c = await cause(() => insertIntentAsSystem({ ...intentValues({ partnerId: s.partner.id, ...two, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id }), ...cancelledWith } as unknown as ReturnType<typeof intentValues>));
    expect(c?.code).toBe('23505');
  });

  it('goes with its devices (FK cascade)', async () => {
    const s = await seedPartnerWithOrgs();
    const intents = await seedIntents(s);
    await getTestDb().execute(sql`DELETE FROM devices WHERE id = ${intents.ownBoth.targetDeviceId}::uuid`);
    const left = await getTestDb().select({ id: deviceReattachIntents.id }).from(deviceReattachIntents)
      .where(eq(deviceReattachIntents.id, intents.ownBoth.id));
    expect(left).toEqual([]);
  });
});

function ledgerValues(input: { partnerId: string; sourceOrgId: string; targetOrgId: string; sourceParked: boolean }) {
  return {
    partnerId: input.partnerId,
    intentId: randomUUID(),
    sourceDeviceId: randomUUID(),
    sourceAgentId: `src-${randomUUID()}`.slice(0, 64),
    sourceOrgId: input.sourceOrgId,
    sourceParked: input.sourceParked,
    targetDeviceId: randomUUID(),
    targetOrgId: input.targetOrgId,
    targetSiteId: randomUUID(),
    targetPreviousAgentId: `old-${randomUUID()}`.slice(0, 64),
    stagedAgentId: `new-${randomUUID()}`.slice(0, 64),
    targetPreviousIncarnation: 1,
    targetNewIncarnation: 2,
    actorUserId: randomUUID(),
    evidenceLevel: 'hint' as const,
    confirmationTokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
  };
}

async function insertLedgerAsSystem(values: ReturnType<typeof ledgerValues>) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(deviceReattachments).values(values).returning({ id: deviceReattachments.id }));
  return row!;
}

describe('device_reattachments RLS (breeze_app)', () => {
  it('refuses INSERT outside system scope, own partner included (42501)', async () => {
    const s = await seedPartnerWithOrgs();
    const c = await cause(() => withDbAccessContext(s.admin, () => db.insert(deviceReattachments)
      .values(ledgerValues({ partnerId: s.partner.id, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id, sourceParked: false }))));
    expect(c?.code).toBe('42501');
  });

  it('a technician reads only the reattaches that touch their orgs; another partner reads none', async () => {
    const s = await seedPartnerWithOrgs();
    const base = { partnerId: s.partner.id };
    const own = await insertLedgerAsSystem(ledgerValues({ ...base, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id, sourceParked: false }));
    const parked = await insertLedgerAsSystem(ledgerValues({ ...base, sourceOrgId: s.pool.orgId, targetOrgId: s.orgA.id, sourceParked: true }));
    const foreignTarget = await insertLedgerAsSystem(ledgerValues({ ...base, sourceOrgId: s.orgA.id, targetOrgId: s.orgB.id, sourceParked: false }));
    const foreignSource = await insertLedgerAsSystem(ledgerValues({ ...base, sourceOrgId: s.orgB.id, targetOrgId: s.orgA.id, sourceParked: false }));
    const ids = [own.id, parked.id, foreignTarget.id, foreignSource.id];
    const read = (ctx: DbAccessContext) => withDbAccessContext(ctx, () =>
      db.select({ id: deviceReattachments.id }).from(deviceReattachments))
      .then((rows) => rows.map((r) => r.id).filter((id) => ids.includes(id)).sort());

    expect(await read(s.techA)).toEqual([own.id, parked.id].sort());
    expect(await read(s.admin)).toEqual([...ids].sort());
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    expect(await read({ scope: 'partner', orgId: null, accessibleOrgIds: [otherOrg.id], accessiblePartnerIds: [other.id] })).toEqual([]);
  });

  it('refuses UPDATE even in system scope (append-only trigger), and DELETE outside system scope', async () => {
    const s = await seedPartnerWithOrgs();
    const row = await insertLedgerAsSystem(ledgerValues({ partnerId: s.partner.id, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id, sourceParked: false }));
    const c = await cause(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE device_reattachments SET step_up_grant_ref = 'x' WHERE id = ${row.id}::uuid`)));
    expect(c?.code).toBe('P0001');
    expect(c?.message).toMatch(/append-only/);

    const partnerDeleted = await withDbAccessContext(s.admin, () =>
      db.delete(deviceReattachments).where(eq(deviceReattachments.id, row.id)).returning({ id: deviceReattachments.id }));
    expect(partnerDeleted).toEqual([]);
    // The partner erasure sweep's statement shape, in system scope.
    await withSystemDbAccessContext(() => db.execute(sql`DELETE FROM device_reattachments WHERE partner_id = ${s.partner.id}::uuid`));
    const left = await getTestDb().select({ id: deviceReattachments.id }).from(deviceReattachments)
      .where(eq(deviceReattachments.partnerId, s.partner.id));
    expect(left).toEqual([]);
  });

  it('refuses a malformed row (incarnation that does not advance by one, malformed hash)', async () => {
    const s = await seedPartnerWithOrgs();
    const base = ledgerValues({ partnerId: s.partner.id, sourceOrgId: s.orgA.id, targetOrgId: s.orgA.id, sourceParked: false });
    expect((await cause(() => insertLedgerAsSystem({ ...base, targetNewIncarnation: 3 })))?.code).toBe('23514');
    expect((await cause(() => insertLedgerAsSystem({ ...base, confirmationTokenHash: 'nope' })))?.code).toBe('23514');
  });

  it('carries no device, org or user FK (the record outlives them); the partner FK cascades', async () => {
    const fks = await getTestDb().execute(sql`
      SELECT confrelid::regclass::text AS target, confdeltype
        FROM pg_constraint
       WHERE conrelid = 'device_reattachments'::regclass AND contype = 'f'`);
    expect(fks as unknown as Array<{ target: string; confdeltype: string }>).toEqual([{ target: 'partners', confdeltype: 'c' }]);
  });
});
