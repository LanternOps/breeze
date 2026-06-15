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
import { eq, and } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, users, contracts, contractBillingPeriods, contractLines, invoiceLines, invoices } from '../../db/schema';
import {
  createContract, getContract, addContractLineToContract, updateContract, listContracts,
  activateContract, pauseContract, resumeContract, cancelContract, generateDueInvoice,
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

describe('contractService generation', () => {
  // Generation creates a real invoice, which stamps invoices.created_by from the
  // actor's userId (FK → users). So generation tests need a REAL user as createdBy
  // (the contract carries it through), unlike the CRUD/lifecycle tests which never
  // create an invoice and can leave createdBy null.
  async function seedOrgWithUser(): Promise<{ actor: ContractActorT; orgId: string }> {
    const { orgId } = await seedOrg();
    const sfx = Math.random().toString(36).slice(2, 8);
    let partnerId = '';
    let userId = '';
    await withSystemDbAccessContext(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId })
        .from(organizations).where(eq(organizations.id, orgId)).limit(1);
      partnerId = org!.partnerId;
      const [u] = await db.insert(users).values({
        partnerId, orgId, email: `gen-${sfx}@x.io`, name: 'Gen User', status: 'active'
      }).returning({ id: users.id });
      userId = u!.id;
    });
    return { actor: { userId, partnerId, accessibleOrgIds: [orgId] }, orgId };
  }

  it('generates exactly one draft invoice for the due period (idempotent)', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'GenTest', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed', unitPrice: '500.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T08:00:00Z')));

    const res = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T08:00:00Z')));
    expect(res.generated).toBe(true);
    expect(res.invoiceId).toBeTruthy();

    // Second serial run is a no-op: the pointer already advanced to 2026-08-01,
    // so the next period is not yet due. (The ledger's already_billed path is the
    // belt-and-suspenders guard for the CONCURRENT race — exercised below.)
    const again = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T09:00:00Z')));
    expect(again.generated).toBe(false);
    expect(again.skipped).toBe('not_due');

    // Exactly one billing-period row for the contract proves no double-billing.
    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, c.id)));
    expect(periods).toHaveLength(1);
    expect(periods[0]!.periodStart).toBe('2026-07-01');
    expect(periods[0]!.invoiceId).toBe(res.invoiceId);
  });

  it('skips with already_billed when the period was already claimed (race loser)', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'RaceTest', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Managed', unitPrice: '500.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T08:00:00Z')));

    // First run claims the July period and advances the pointer to 2026-08-01.
    const first = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T08:00:00Z')));
    expect(first.generated).toBe(true);

    // Simulate a concurrent run that started against the SAME period: rewind the
    // pointer to 2026-07-01 so generateDueInvoice re-targets the already-claimed
    // July period. The ledger unique constraint must reject the re-claim, the
    // loser deletes its own draft, and the pointer is NOT advanced again.
    await withSystemDbAccessContext(() =>
      db.update(contracts).set({ nextBillingAt: '2026-07-01' }).where(eq(contracts.id, c.id)));

    const loser = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T08:05:00Z')));
    expect(loser.generated).toBe(false);
    expect(loser.skipped).toBe('already_billed');

    // Still exactly one billing-period row, and the loser's draft was reaped.
    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, c.id)));
    expect(periods).toHaveLength(1);
    const drafts = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(eq(invoiceLines.sourceType, 'contract')));
    // Only the winning invoice's contract line remains (loser's draft cascaded away).
    expect(drafts.every((l) => l.invoiceId === first.invoiceId)).toBe(true);
  });

  it('generates successfully when the contract has createdBy = null (FK cliff fix)', async () => {
    // System-seeded / imported contracts have createdBy NULL. Before the fix, the
    // zero-uuid sentinel triggered a 23503 FK violation on invoices.created_by.
    // After the fix, null propagates cleanly and invoices.created_by stays null.
    const sfx = Math.random().toString(36).slice(2, 8);
    let contractId = '';
    let partnerId = '';
    let orgId = '';
    await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({
        name: `SysPart-${sfx}`, slug: `sp-${sfx}`, type: 'msp', plan: 'pro', status: 'active'
      }).returning({ id: partners.id });
      partnerId = p!.id;
      const [o] = await db.insert(organizations).values({
        partnerId, name: `SysOrg-${sfx}`, slug: `so-${sfx}`
      }).returning({ id: organizations.id });
      orgId = o!.id;
      // Insert contract directly with createdBy: null — simulates a system-seeded /
      // imported contract that has no originating user.
      const [c] = await db.insert(contracts).values({
        partnerId, orgId, name: 'Sys Contract', status: 'active',
        billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01',
        nextBillingAt: '2026-07-01', autoIssue: false, currencyCode: 'USD',
        createdBy: null
      }).returning({ id: contracts.id });
      contractId = c!.id;
      await db.insert(contractLines).values({
        contractId, orgId, lineType: 'flat', description: 'Flat fee', unitPrice: '100.00',
        taxable: false, sortOrder: 0
      });
    });

    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(contractId, new Date('2026-07-01T08:00:00Z'))
    );

    expect(res.generated).toBe(true);
    expect(res.invoiceId).toBeTruthy();

    // The invoice's created_by column must be null — NOT the zero-uuid sentinel.
    const [inv] = await withSystemDbAccessContext(() =>
      db.select({ createdBy: invoices.createdBy }).from(invoices)
        .where(eq(invoices.id, res.invoiceId!)).limit(1)
    );
    expect(inv!.createdBy).toBeNull();
  });

  it('resolves a per_device line quantity to the live device count', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    const sfx = Math.random().toString(36).slice(2, 8);
    // Seed two non-decommissioned devices org-wide (no site filter on the line).
    // devices.site_id is NOT NULL, so seed a site to hang them on.
    await withSystemDbAccessContext(async () => {
      const [s] = await db.insert(sites).values({ orgId, name: `GenSite-${sfx}` }).returning({ id: sites.id });
      await db.insert(devices).values([
        { orgId, siteId: s!.id, agentId: `g1-${sfx}`, hostname: 'g1', status: 'online',  osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
        { orgId, siteId: s!.id, agentId: `g2-${sfx}`, hostname: 'g2', status: 'offline', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      ]);
    });
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'PerDevice', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device', description: 'RMM per device', unitPrice: '15.00', taxable: true
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T08:00:00Z')));

    const res = await withSystemDbAccessContext(() => generateDueInvoice(c.id, new Date('2026-07-01T08:00:00Z')));
    expect(res.generated).toBe(true);

    const lines = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(and(
        eq(invoiceLines.invoiceId, res.invoiceId!), eq(invoiceLines.sourceType, 'contract')
      )));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('2.00');        // two non-decommissioned devices (numeric(12,2))
    expect(lines[0]!.unitPrice).toBe('15.00');
    expect(lines[0]!.lineTotal).toBe('30.00');      // 2 * 15.00
  });
});
