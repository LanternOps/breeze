/**
 * device_pool_assignment_events — cross-partner forge proof (breeze_app role).
 * Migration under test: 2026-11-08-190200-device-pool-assignment-events.sql.
 * and 2026-11-08-190300-device-pool-assignment-events-system-only.sql.
 * Shape 3 (partner-axis): system OR breeze_has_partner_access(partner_id),
 * narrowed by a RESTRICTIVE system-only policy: every read and write goes
 * through system scope (the dedicated full-partner-admin endpoints and the
 * admission/assignment/expiry transactions), never a partner request context.
 * Proves: partner-scope INSERT refused for any partner (42501); partner-scope
 * SELECT and DELETE see nothing, own partner included; system scope reads and
 * deletes; UPDATE refused by trigger even in system scope; per-event shape
 * CHECKs; rows survive deletion of the device they describe; rows go with the
 * partner.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devicePoolAssignmentEvents, devices } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';
import { seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

async function cause(fn: () => Promise<unknown>) {
  try { await fn(); return undefined; } catch (err) {
    return (err as { cause?: { code?: string; message?: string } }).cause;
  }
}

async function seedTwoPartners() {
  const a = await createPartner();
  const orgA = await createOrganization({ partnerId: a.id });
  const b = await createPartner();
  const ctxA: DbAccessContext = { scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [a.id] };
  return { a, b, ctxA };
}

const enrolled = (partnerId: string, toOrgId: string) => ({
  partnerId,
  deviceId: randomUUID(),
  deviceAgentId: `agent-${randomUUID()}`.slice(0, 64),
  eventType: 'enrolled' as const,
  toOrgId,
  parkedAt: new Date(),
});

describe('device_pool_assignment_events RLS (breeze_app)', () => {
  it('refuses a cross-partner INSERT', async () => {
    const { b, ctxA } = await seedTwoPartners();
    const poolB = await seedHoldingOrg(b.id);
    const c = await cause(() => withDbAccessContext(ctxA, () =>
      db.insert(devicePoolAssignmentEvents).values(enrolled(b.id, poolB.orgId))));
    expect(c?.code).toBe('42501');
    expect(c?.message).toMatch(/row-level security policy for table "device_pool_assignment_events"/);
  });

  it('refuses an own-partner INSERT from a partner request context', async () => {
    const { a, ctxA } = await seedTwoPartners();
    const poolA = await seedHoldingOrg(a.id);
    const c = await cause(() => withDbAccessContext(ctxA, () =>
      db.insert(devicePoolAssignmentEvents).values(enrolled(a.id, poolA.orgId))));
    expect(c?.code).toBe('42501');
    expect(c?.message).toMatch(/row-level security policy "device_pool_assignment_events_system_only" for table "device_pool_assignment_events"/);
  });

  it('hides every ledger row from a partner request context, own partner included; system scope sees them', async () => {
    const { a, b, ctxA } = await seedTwoPartners();
    const poolA = await seedHoldingOrg(a.id);
    const poolB = await seedHoldingOrg(b.id);
    const [rowA] = await withSystemDbAccessContext(() => db.insert(devicePoolAssignmentEvents).values(enrolled(a.id, poolA.orgId)).returning({ id: devicePoolAssignmentEvents.id }));
    const [rowB] = await withSystemDbAccessContext(() => db.insert(devicePoolAssignmentEvents).values(enrolled(b.id, poolB.orgId)).returning({ id: devicePoolAssignmentEvents.id }));
    const own = await withDbAccessContext(ctxA, () => db.select({ id: devicePoolAssignmentEvents.id }).from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, rowA!.id)));
    const cross = await withDbAccessContext(ctxA, () => db.select({ id: devicePoolAssignmentEvents.id }).from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, rowB!.id)));
    const system = await withSystemDbAccessContext(() => db.select({ id: devicePoolAssignmentEvents.id }).from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, rowA!.id)));
    expect(own).toEqual([]);
    expect(cross).toEqual([]);
    expect(system).toHaveLength(1);
  });

  it('refuses DELETE from a partner request context and allows it in system scope', async () => {
    const { a, ctxA } = await seedTwoPartners();
    const poolA = await seedHoldingOrg(a.id);
    const [row] = await withSystemDbAccessContext(() => db.insert(devicePoolAssignmentEvents).values(enrolled(a.id, poolA.orgId)).returning({ id: devicePoolAssignmentEvents.id }));
    const partnerDeleted = await withDbAccessContext(ctxA, () =>
      db.delete(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, row!.id)).returning({ id: devicePoolAssignmentEvents.id }));
    expect(partnerDeleted).toEqual([]);
    const stillThere = await getTestDb().select({ id: devicePoolAssignmentEvents.id }).from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, row!.id));
    expect(stillThere).toHaveLength(1);

    const systemDeleted = await withSystemDbAccessContext(() =>
      db.delete(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, row!.id)).returning({ id: devicePoolAssignmentEvents.id }));
    expect(systemDeleted).toHaveLength(1);
  });

  it('the partner erasure sweep (system scope, partner_id predicate) still removes the ledger rows', async () => {
    const { a } = await seedTwoPartners();
    const poolA = await seedHoldingOrg(a.id);
    await withSystemDbAccessContext(() => db.insert(devicePoolAssignmentEvents).values(enrolled(a.id, poolA.orgId)));
    // Same statement shape as cascadeDeletePartner's dynamic partner_id sweep.
    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM device_pool_assignment_events WHERE partner_id = ${a.id}::uuid`));
    const left = await getTestDb().select({ id: devicePoolAssignmentEvents.id }).from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.partnerId, a.id));
    expect(left).toEqual([]);
  });

  it('refuses UPDATE even in system scope (append-only trigger)', async () => {
    const { a } = await seedTwoPartners();
    const pool = await seedHoldingOrg(a.id);
    const [row] = await withSystemDbAccessContext(() => db.insert(devicePoolAssignmentEvents).values(enrolled(a.id, pool.orgId)).returning({ id: devicePoolAssignmentEvents.id }));
    const c = await cause(() => withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE device_pool_assignment_events SET deploy_key_name = 'x' WHERE id = ${row!.id}::uuid`)));
    expect(c?.code).toBe('P0001');
    expect(c?.message).toMatch(/append-only/);
  });

  it.each([
    ['enrolled with a from org', { eventType: 'enrolled', fromOrgId: randomUUID() }],
    ['assigned without a method', { eventType: 'assigned', fromOrgId: randomUUID(), assignedByUserId: randomUUID(), parkedDurationSeconds: 5 }],
    ['expired with a to org', { eventType: 'expired', fromOrgId: randomUUID() }],
    ['unknown event type', { eventType: 'moved' }],
    ['negative duration', { eventType: 'expired', fromOrgId: randomUUID(), toOrgId: null, parkedDurationSeconds: -1 }],
  ])('rejects malformed row: %s', async (_label, patch) => {
    const { a } = await seedTwoPartners();
    const pool = await seedHoldingOrg(a.id);
    const c = await cause(() => withSystemDbAccessContext(() =>
      db.insert(devicePoolAssignmentEvents).values({ ...enrolled(a.id, pool.orgId), ...(patch as object) } as any)));
    expect(c?.code).toBe('23514');
  });

  it('keeps the record after the device row is deleted, and drops it with the partner', async () => {
    const { a } = await seedTwoPartners();
    const pool = await seedHoldingOrg(a.id);
    const device = await seedParkedDevice(pool.orgId, pool.siteId);
    const [row] = await withSystemDbAccessContext(() => db.insert(devicePoolAssignmentEvents).values({
      ...enrolled(a.id, pool.orgId), deviceId: device.id, deviceAgentId: device.agentId,
    }).returning({ id: devicePoolAssignmentEvents.id }));
    await getTestDb().delete(devices).where(eq(devices.id, device.id));
    const survived = await getTestDb().select().from(devicePoolAssignmentEvents).where(eq(devicePoolAssignmentEvents.id, row!.id));
    expect(survived).toHaveLength(1);
    // Partner deletion in tests is blocked by other FK children (organizations),
    // so the partner FK's ON DELETE CASCADE is asserted from the catalog instead.
    const fk = await getTestDb().execute(sql`
      SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'device_pool_assignment_events'::regclass AND contype = 'f'`);
    expect((fk as unknown as Array<{ confdeltype: string }>).map((r) => r.confdeltype)).toEqual(['c']);
  });
});
