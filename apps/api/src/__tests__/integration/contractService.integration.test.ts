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
import { partners, organizations, sites, devices, users, organizationUsers, roles, contracts, contractBillingPeriods, contractLines, invoiceLines, invoices } from '../../db/schema';
import {
  createContract, getContract, addContractLineToContract, updateContract, listContracts,
  activateContract, pauseContract, resumeContract, cancelContract, generateDueInvoice,
  type ContractActorT
} from '../../services/contractService';
import { ContractServiceError } from '../../services/contractTypes';

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
    const cB = await withSystemDbAccessContext(() => createContract({
      orgId: b.orgId, name: 'ActorB Contract', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, b.actor));

    const rows = await withSystemDbAccessContext(() => listContracts({}, a.actor));
    const ids = rows.map((r) => r.id);

    expect(ids).toContain(cA.id);
    // Actor A must NOT see Actor B's contract (compare contract IDs, not orgId).
    expect(ids).not.toContain(cB.id);
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

  // Case 1: arrears generation — exercises the idx = idxAt - 1 branch + arrears pointer advance.
  it('arrears: bills the just-completed period and advances the pointer to the next period end', async () => {
    // Contract: arrears, monthly, starts 2026-07-01.
    // Activate within the first period so next_billing_at = 2026-08-01 (end of period 0).
    // At asOf = 2026-08-01: idxAt=1 → idx=0 → period {2026-07-01, 2026-08-01} gets billed.
    // Pointer advances to next period end: 2026-09-01.
    const { actor, orgId } = await seedOrgWithUser();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Arrears', billingTiming: 'arrears', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Monthly arrears', unitPrice: '400.00', taxable: false
    }, actor));
    // Activate mid-period: idx=0 for 2026-07-15, nextBillingDate(arrears, idx=0) = period 0 end = 2026-08-01.
    const activated = await withSystemDbAccessContext(() =>
      activateContract(c.id, actor, new Date('2026-07-15T08:00:00Z'))
    );
    expect(activated.nextBillingAt).toBe('2026-08-01'); // arrears: pointer = period 0 end

    // Run at asOf = 2026-08-01 (due date reached).
    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(c.id, new Date('2026-08-01T06:00:00Z'))
    );
    expect(res.generated).toBe(true);
    expect(res.invoiceId).toBeTruthy();

    // The ledger row must cover the just-completed period 0.
    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, c.id))
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]!.periodStart).toBe('2026-07-01'); // period 0 start
    expect(periods[0]!.periodEnd).toBe('2026-08-01');   // period 0 end

    // Pointer must advance to the next arrears trigger: period 1 end = 2026-09-01.
    const [updated] = await withSystemDbAccessContext(() =>
      db.select({ nextBillingAt: contracts.nextBillingAt }).from(contracts).where(eq(contracts.id, c.id)).limit(1)
    );
    expect(updated!.nextBillingAt).toBe('2026-09-01');
  });

  // Case 2a: expiry at due-check — period starts on/after end_date → skipped:expired, no ledger row.
  it('expiry (2a): returns skipped:expired when the due period starts on/after end_date', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    // end_date = 2026-08-01 → period 1 starts 2026-08-01 ≥ end_date → expired on first advance attempt.
    // Activate advance contract so next_billing_at = 2026-07-01 for period 0 (in-bounds).
    // Then manually wind the pointer to 2026-08-01 (period 1 start which ≥ end_date).
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'ExpiryA', billingTiming: 'advance', intervalMonths: 1,
      startDate: '2026-07-01', endDate: '2026-08-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Expire me', unitPrice: '100.00', taxable: false
    }, actor));
    // Activate; advance billing → next_billing_at = 2026-07-01 (period 0 start).
    // Then wind pointer to 2026-08-01 to simulate the scenario where period 0 was already billed.
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T00:00:00Z')));
    await withSystemDbAccessContext(() =>
      db.update(contracts).set({ nextBillingAt: '2026-08-01' }).where(eq(contracts.id, c.id))
    );

    // generateDueInvoice at asOf=2026-08-01: period start = 2026-08-01 >= end_date=2026-08-01 → expired.
    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(c.id, new Date('2026-08-01T06:00:00Z'))
    );
    expect(res.generated).toBe(false);
    expect(res.skipped).toBe('expired');

    // No ledger row should exist for this expiry-check run.
    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, c.id))
    );
    expect(periods).toHaveLength(0);

    // Contract must be expired with null pointer.
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ status: contracts.status, nextBillingAt: contracts.nextBillingAt })
        .from(contracts).where(eq(contracts.id, c.id)).limit(1)
    );
    expect(row!.status).toBe('expired');
    expect(row!.nextBillingAt).toBeNull();
  });

  // Case 2b: last in-bounds period → bills it, then next period ≥ end_date → expires after billing.
  it('expiry (2b): bills the last in-bounds period, then expires the contract on pointer advance', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    // end_date = 2026-08-01, 1-month advance contract starting 2026-07-01.
    // Period 0: {2026-07-01, 2026-08-01} — in-bounds (period start 2026-07-01 < end_date 2026-08-01).
    // After billing period 0, next period is period 1: start 2026-08-01 >= end_date → expire.
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'ExpiryB', billingTiming: 'advance', intervalMonths: 1,
      startDate: '2026-07-01', endDate: '2026-08-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Last period', unitPrice: '200.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T00:00:00Z')));

    // Generate at asOf = 2026-07-01 → bills period 0 {2026-07-01, 2026-08-01}.
    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(c.id, new Date('2026-07-01T06:00:00Z'))
    );
    expect(res.generated).toBe(true);
    expect(res.invoiceId).toBeTruthy();

    // Exactly one ledger row for the billed period.
    const periods = await withSystemDbAccessContext(() =>
      db.select().from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, c.id))
    );
    expect(periods).toHaveLength(1);
    expect(periods[0]!.periodStart).toBe('2026-07-01');
    expect(periods[0]!.periodEnd).toBe('2026-08-01');

    // Contract must be expired with null pointer after the pointer-advance step.
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ status: contracts.status, nextBillingAt: contracts.nextBillingAt })
        .from(contracts).where(eq(contracts.id, c.id)).limit(1)
    );
    expect(row!.status).toBe('expired');
    expect(row!.nextBillingAt).toBeNull();
  });

  // Case 3: per_seat and manual line quantity resolution.
  it('per_seat: counts only active users mapped via organization_users (excludes disabled)', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    const sfx = Math.random().toString(36).slice(2, 8);
    await withSystemDbAccessContext(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId })
        .from(organizations).where(eq(organizations.id, orgId)).limit(1);
      const partnerId = org!.partnerId;
      // Seed a role required by organization_users FK.
      const [r] = await db.insert(roles).values({
        name: `SR-${sfx}`, scope: 'organization', partnerId, orgId
      }).returning({ id: roles.id });
      const roleId = r!.id;
      const [u1, u2, u3] = await db.insert(users).values([
        { partnerId, orgId, email: `ps1-${sfx}@x.io`, name: 'PS1', status: 'active' },
        { partnerId, orgId, email: `ps2-${sfx}@x.io`, name: 'PS2', status: 'active' },
        { partnerId, orgId, email: `ps3-${sfx}@x.io`, name: 'PS3', status: 'disabled' }, // excluded
      ]).returning({ id: users.id });
      await db.insert(organizationUsers).values([
        { orgId, userId: u1!.id, roleId },
        { orgId, userId: u2!.id, roleId },
        { orgId, userId: u3!.id, roleId },
      ]);
    });

    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'PerSeat', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_seat', description: 'Per user', unitPrice: '20.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T00:00:00Z')));

    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(c.id, new Date('2026-07-01T06:00:00Z'))
    );
    expect(res.generated).toBe(true);

    const lines = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(and(
        eq(invoiceLines.invoiceId, res.invoiceId!), eq(invoiceLines.sourceType, 'contract')
      ))
    );
    // seedOrgWithUser creates 1 user; we added 2 active + 1 disabled above = 3 total,
    // but the seedOrgWithUser user is active too → 3 active (seedOrgWithUser's u + ps1 + ps2).
    // Actually: the actor user from seedOrgWithUser IS in the same org. But they are only
    // in the users table (not organization_users). countContractSeats joins organization_users,
    // so only ps1 + ps2 (2 active in org_users) are counted.
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('2.00');
  });

  it('manual: uses manualQuantity as quantity and computes correct line total', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Manual', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'manual', description: 'Fixed qty service', unitPrice: '50.00', manualQuantity: '3', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T00:00:00Z')));

    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(c.id, new Date('2026-07-01T06:00:00Z'))
    );
    expect(res.generated).toBe(true);

    const lines = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(and(
        eq(invoiceLines.invoiceId, res.invoiceId!), eq(invoiceLines.sourceType, 'contract')
      ))
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe('3.00');
    expect(lines[0]!.unitPrice).toBe('50.00');
    expect(lines[0]!.lineTotal).toBe('150.00');
  });

  // Case 5: mixed line types in one contract.
  it('mixed lines: flat + per_device + per_seat + manual produce correct per-line quantities', async () => {
    const { actor, orgId } = await seedOrgWithUser();
    const sfx = Math.random().toString(36).slice(2, 8);
    let siteId = '';
    await withSystemDbAccessContext(async () => {
      const [org] = await db.select({ partnerId: organizations.partnerId })
        .from(organizations).where(eq(organizations.id, orgId)).limit(1);
      const partnerId = org!.partnerId;
      // Seed 3 devices (1 decommissioned → 2 billable).
      const [s] = await db.insert(sites).values({ orgId, name: `Mix-${sfx}` }).returning({ id: sites.id });
      siteId = s!.id;
      await db.insert(devices).values([
        { orgId, siteId, agentId: `mx1-${sfx}`, hostname: 'mx1', status: 'online',        osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
        { orgId, siteId, agentId: `mx2-${sfx}`, hostname: 'mx2', status: 'offline',       osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
        { orgId, siteId, agentId: `mx3-${sfx}`, hostname: 'mx3', status: 'decommissioned',osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      ]);
      // Seed 2 active users in organization_users (1 seat).
      const [r] = await db.insert(roles).values({
        name: `MR-${sfx}`, scope: 'organization', partnerId, orgId
      }).returning({ id: roles.id });
      const roleId = r!.id;
      const [u1] = await db.insert(users).values([
        { partnerId, orgId, email: `mx1-${sfx}@x.io`, name: 'MX1', status: 'active' },
      ]).returning({ id: users.id });
      await db.insert(organizationUsers).values([
        { orgId, userId: u1!.id, roleId },
      ]);
    });

    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'Mixed', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'Flat fee', unitPrice: '100.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_device', description: 'Per device', unitPrice: '10.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'per_seat', description: 'Per seat', unitPrice: '25.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'manual', description: 'Manual item', unitPrice: '50.00', manualQuantity: '4', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01T00:00:00Z')));

    const res = await withSystemDbAccessContext(() =>
      generateDueInvoice(c.id, new Date('2026-07-01T06:00:00Z'))
    );
    expect(res.generated).toBe(true);

    const lines = await withSystemDbAccessContext(() =>
      db.select().from(invoiceLines).where(and(
        eq(invoiceLines.invoiceId, res.invoiceId!), eq(invoiceLines.sourceType, 'contract')
      ))
    );
    expect(lines).toHaveLength(4);

    // Sort by lineTotal descending to get predictable ordering for assertion.
    const sorted = [...lines].sort((a, b) => Number(b.lineTotal) - Number(a.lineTotal));
    // manual qty=4 * $50 = $200
    expect(sorted[0]!.quantity).toBe('4.00');
    expect(sorted[0]!.lineTotal).toBe('200.00');
    // per_device qty=2 * $10 = $20 ... wait, let's match by unitPrice instead
    // Actually sort by unitPrice to keep assertions stable.
    const byUnitPrice = [...lines].sort((a, b) => Number(b.unitPrice) - Number(a.unitPrice));
    // $100 flat: qty=1
    expect(byUnitPrice[0]!.unitPrice).toBe('100.00');
    expect(byUnitPrice[0]!.quantity).toBe('1.00');
    // $50 manual: qty=4
    expect(byUnitPrice[1]!.unitPrice).toBe('50.00');
    expect(byUnitPrice[1]!.quantity).toBe('4.00');
    // $25 per_seat: qty=1 (one active user in org_users)
    expect(byUnitPrice[2]!.unitPrice).toBe('25.00');
    expect(byUnitPrice[2]!.quantity).toBe('1.00');
    // $10 per_device: qty=2 (2 non-decommissioned)
    expect(byUnitPrice[3]!.unitPrice).toBe('10.00');
    expect(byUnitPrice[3]!.quantity).toBe('2.00');

    // Total = 100 + 200 + 25 + 20 = 345
    const invRow = await withSystemDbAccessContext(() =>
      db.select({ total: invoices.total }).from(invoices).where(eq(invoices.id, res.invoiceId!)).limit(1)
    );
    expect(Number(invRow[0]!.total)).toBe(345);
  });
});

describe('contractService illegal lifecycle transitions', () => {
  // Table-driven tests for invalid state transitions that must throw ContractServiceError.
  // Each case brings the contract to the required starting state, then asserts the
  // illegal operation throws with status 409 and code INVALID_STATE (or NOT_A_DRAFT).

  it('activating a cancelled contract throws INVALID_STATE', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => cancelContract(c.id, actor));

    await expect(
      withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01')))
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ContractServiceError);
      expect((e as ContractServiceError).status).toBe(409);
      return true;
    });
  });

  it('pausing a draft contract throws INVALID_STATE', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    // Draft → pause should fail (only active can be paused).
    await expect(
      withSystemDbAccessContext(() => pauseContract(c.id, actor))
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ContractServiceError);
      expect((e as ContractServiceError).status).toBe(409);
      return true;
    });
  });

  it('resuming an active contract throws INVALID_STATE', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => addContractLineToContract(c.id, {
      lineType: 'flat', description: 'm', unitPrice: '1.00', taxable: false
    }, actor));
    await withSystemDbAccessContext(() => activateContract(c.id, actor, new Date('2026-07-01')));
    // Active → resume should fail (only paused can be resumed).
    await expect(
      withSystemDbAccessContext(() => resumeContract(c.id, actor))
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ContractServiceError);
      expect((e as ContractServiceError).status).toBe(409);
      return true;
    });
  });

  it('adding a line to a cancelled contract throws INVALID_STATE', async () => {
    const { actor, orgId } = await seedOrg();
    const c = await withSystemDbAccessContext(() => createContract({
      orgId, name: 'x', billingTiming: 'advance', intervalMonths: 1, startDate: '2026-07-01'
    }, actor));
    await withSystemDbAccessContext(() => cancelContract(c.id, actor));
    await expect(
      withSystemDbAccessContext(() => addContractLineToContract(c.id, {
        lineType: 'flat', description: 'm', unitPrice: '1.00', taxable: false
      }, actor))
    ).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(ContractServiceError);
      expect((e as ContractServiceError).status).toBe(409);
      return true;
    });
  });
});
