/**
 * Real-driver service-layer tests for contractService.
 *
 * Runs under vitest.integration.config.ts — tests run against a real Postgres
 * with the breeze_app role so RLS is exercised alongside the service-layer
 * access guards.
 *
 * Fixture topology (seeded fresh per test under system scope):
 *   partnerA → orgA  (actor A has access)
 *   partnerB → orgB  (actor B is the cross-org foil)
 *
 * Why NO memoization: integration/setup.ts runs cleanupDatabase() in a
 * beforeEach that TRUNCATE ... CASCADEs partners/organizations before every
 * test. Each test re-seeds via seedOrg().
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations } from '../../db/schema';
import {
  createContract, getContract, addContractLineToContract, updateContract, listContracts,
  activateContract, pauseContract, resumeContract, cancelContract,
  type ContractActorT
} from '../../services/contractService';

async function seedOrg(): Promise<{ actor: ContractActorT; orgId: string }> {
  const sfx = Math.random().toString(36).slice(2, 8);
  let orgId = ''; let partnerId = '';
  await withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `CP ${sfx}`, slug: `cp-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
    }).returning({ id: partners.id });
    partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: 'COrg', slug: `co-${sfx}`
    }).returning({ id: organizations.id });
    orgId = o!.id;
  });
  // userId null: createdBy is nullable on contracts; no real user row needed for these tests.
  return { actor: { userId: null as unknown as string, partnerId, accessibleOrgIds: [orgId] }, orgId };
}

describe('contractService CRUD', () => {
  it('creates a draft contract and reads it back', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Acme MSP', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    expect(c.status).toBe('draft');
    const got = await withSystemDbAccessContext(() => getContract(c.id, actor));
    expect(got.contract.name).toBe('Acme MSP');
    expect(got.lines).toHaveLength(0);
  });

  it('adds flat + per_device lines to a draft', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'LineTest', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed Services', unitPrice: '500.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device', description: 'RMM per device', unitPrice: '15.00', taxable: true
    }, actor));
    const got = await withSystemDbAccessContext(() => getContract(c.id, actor));
    expect(got.lines).toHaveLength(2);
    expect(got.lines.map((l) => l.lineType).sort()).toEqual(['flat', 'per_device']);
  });

  it('rejects cross-org access (service-layer guard)', async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId: a.orgId, name: 'OrgA Contract', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, a.actor));
    // Actor B's accessibleOrgIds does not include a.orgId — service must deny.
    await expect(
      withSystemDbAccessContext(() => getContract(c.id, b.actor))
    ).rejects.toThrow(/not found|denied/i);
  });

  // Fix 1: updateContract mass-assignment guard
  it('updateContract ignores forged status/orgId fields and applies only whitelisted fields', async () => {
    const { actor, orgId } = await seedOrg();
    const otherSeed = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Original', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    expect(c.status).toBe('draft');

    // Cast to bypass TS — simulates a malicious payload with forbidden fields.
    const updated = await withSystemDbAccessContext(() => updateContract(
      c.id,
      { name: 'Renamed', notes: 'updated notes', status: 'active', orgId: otherSeed.orgId } as never,
      actor
    ));

    // Whitelisted fields applied.
    expect(updated.name).toBe('Renamed');
    expect(updated.notes).toBe('updated notes');
    // Forbidden fields NOT applied — must remain at original values.
    expect(updated.status).toBe('draft');
    expect(updated.orgId).toBe(orgId);
  });

  // Fix 3: createContract derives partnerId from org row
  it('createContract sets partnerId from org row, not actor.partnerId', async () => {
    const { actor, orgId } = await seedOrg();
    // We know seedOrg creates an org under actor.partnerId. Corrupt the actor to point at a
    // different (non-existent) partnerId — contract must still use the real org partner.
    const realPartnerId = actor.partnerId;
    const corruptActor = { ...actor, partnerId: '00000000-0000-0000-0000-000000000099' };

    // requireOrgAccess will pass (accessibleOrgIds still contains orgId).
    // The partner guard ("Partner scope required") checks !== null, so non-null passes.
    // But the org lookup will find the real org and use its partnerId.
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'PartnerTest', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, corruptActor));

    expect(c.partnerId).toBe(realPartnerId);
    expect(c.partnerId).not.toBe(corruptActor.partnerId);
  });

  // Fix 2: listContracts defense-in-depth inArray filter
  it('listContracts returns only the calling actor\'s accessible org contracts', async () => {
    const a = await seedOrg();
    const b = await seedOrg();

    const cA = await withSystemDbAccessContext(() => createContract({
      orgId: a.orgId, name: 'ActorA Contract', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, a.actor));
    await withSystemDbAccessContext(() => createContract({
      orgId: b.orgId, name: 'ActorB Contract', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, b.actor));

    const rows = await withSystemDbAccessContext(() => listContracts({}, a.actor));
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(cA.id);
    // Actor A must NOT see Actor B's contract.
    expect(ids).not.toContain(b.orgId);
    expect(rows.every((r) => r.orgId === a.orgId)).toBe(true);
  });
});

describe('contractService lifecycle', () => {
  it('activate requires a line and sets next_billing_at', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    // Must reject before any line exists
    await expect(
      withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01')))
    ).rejects.toThrow(/line/i);
    // Add a line
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'm', unitPrice: '500.00', taxable: false
    }, actor));
    const active = await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01')));
    expect(active.status).toBe('active');
    // advance billing, period 0 start = 2026-07-01
    expect(active.nextBillingAt).toBe('2026-07-01');
  });

  it('pause clears the pointer; resume recomputes forward without back-billing', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-01-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'm', unitPrice: '1.00', taxable: false
    }, actor));
    // Activate as of Jan 1 → nextBillingAt = 2026-01-01
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-01-01')));
    const paused = await withSystemDbAccessContext(() => pauseContract(c.id, actor));
    expect(paused.status).toBe('paused');
    expect(paused.nextBillingAt).toBeNull();
    // Resume as of 2026-06-10 → current period start = 2026-06-01 (advance), no back-billing Jan–May
    const resumed = await withSystemDbAccessContext(() => resumeContract(c.id, actor, '2026-06-10'));
    expect(resumed.status).toBe('active');
    expect(resumed.nextBillingAt).toBe('2026-06-01');
  });

  it('cancel is terminal and idempotent', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    const cancelled = await withSystemDbAccessContext(() => cancelContract(c.id, actor));
    expect(cancelled.status).toBe('cancelled');
    // Calling cancel again on an already-cancelled contract should not throw
    const again = await withSystemDbAccessContext(() => cancelContract(c.id, actor));
    expect(again.status).toBe('cancelled');
  });
});
