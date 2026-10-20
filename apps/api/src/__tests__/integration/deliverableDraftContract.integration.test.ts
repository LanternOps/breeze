/**
 * #9309 — deliverables on a DRAFT contract are paused, and re-based onto the
 * real start when the contract is activated or its start date changes.
 *
 * Real Postgres, because the claims are about what the sweep's select and the
 * contract lifecycle functions actually commit: the draft exclusion is a
 * correlated subquery over `contracts`, and the re-base runs inside
 * activateContract's / updateContract's own transaction.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { contractLines, contracts, serviceDeliverableOccurrences, serviceDeliverables, tickets } from '../../db/schema';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { runDeliverableSweep, handleContractEvent } from '../../jobs/deliverableWorker';
import { activateContract, pauseContract, resumeContract, updateContract } from '../../services/contractService';

vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});
// The lifecycle functions emit to the contract-events BullMQ queue; the
// consumer's job body is called directly instead.
vi.mock('../../services/contractEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/contractEvents')>();
  return { ...actual, emitContractEvent: vi.fn(async () => {}) };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

const AS_OF = new Date('2026-10-25T05:18:00Z');
const TODAY = '2026-10-25';
const system = <T>(fn: () => Promise<T>) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, 'deliverableDraftContract.integration'));

interface Tenant { partnerId: string; orgId: string; techId: string }
const actorOf = (t: Tenant) => ({ userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: null });

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [{ resource: 'tickets', action: 'read' }, { resource: 'tickets', action: 'write' }]);
  const tech = (await createUser({ partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech' }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');
  return { partnerId: partner.id, orgId: org.id, techId: tech.id };
}

async function seedContract(t: Tenant, over: Partial<typeof contracts.$inferInsert> = {}): Promise<string> {
  const [c] = await getTestDb().insert(contracts).values({
    partnerId: t.partnerId, orgId: t.orgId, name: 'Managed services', status: 'draft',
    intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD', ...over,
  }).returning({ id: contracts.id });
  await getTestDb().insert(contractLines).values({
    contractId: c!.id, orgId: t.orgId, lineType: 'manual', description: 'Seats', unitPrice: '1.00',
  });
  return c!.id;
}

async function seedDeliverable(t: Tenant, over: Partial<typeof serviceDeliverables.$inferInsert> = {}): Promise<string> {
  const [row] = await getTestDb().insert(serviceDeliverables).values({
    orgId: t.orgId, name: `Deliverable ${randomUUID().slice(0, 8)}`, cadence: 'monthly',
    anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
    leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve',
    ownerUserId: t.techId, ...over,
  }).returning({ id: serviceDeliverables.id });
  return row!.id;
}

const schedule = async (id: string) => (await getTestDb()
  .select({ effectiveFrom: serviceDeliverables.effectiveFrom, anchorDueDate: serviceDeliverables.anchorDueDate })
  .from(serviceDeliverables).where(eq(serviceDeliverables.id, id)))[0]!;
const occurrencesOf = (deliverableId: string) => getTestDb().select().from(serviceDeliverableOccurrences)
  .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId));
const ticketsOf = (orgId: string) => getTestDb().select().from(tickets).where(eq(tickets.orgId, orgId));

describe('deliverables on a draft contract (#9309)', () => {
  runDb('a deliverable on a draft contract inside its lead window creates and opens nothing; once active it opens', async () => {
    const t = await seedTenant();
    const contractId = await seedContract(t);
    const d = await seedDeliverable(t, { contractId });

    const paused = await runDeliverableSweep(AS_OF);
    expect(paused).toMatchObject({ deliverables: 0, materialized: 0, opened: 0, missed: 0 });
    expect(await occurrencesOf(d)).toHaveLength(0);
    expect(await ticketsOf(t.orgId)).toHaveLength(0);

    // Positive control: the same deliverable, contract flipped to active, opens.
    await getTestDb().update(contracts).set({ status: 'active' }).where(eq(contracts.id, contractId));
    const live = await runDeliverableSweep(AS_OF);
    expect(live).toMatchObject({ deliverables: 1, materialized: 1, opened: 1, failed: 0 });
  });

  runDb('a draft contract never marks its deliverable\'s occurrences missed', async () => {
    const t = await seedTenant();
    const contractId = await seedContract(t);
    // Way past grace — on a live contract this would materialize as missed.
    const d = await seedDeliverable(t, { contractId, cadence: 'one_time', anchorDueDate: '2026-09-01', effectiveFrom: '2026-09-01' });
    expect((await runDeliverableSweep(AS_OF)).missed).toBe(0);
    expect(await occurrencesOf(d)).toHaveLength(0);
  });

  runDb('D1 regression guard: deliverables on expired and paused contracts still sweep, as does a contract-less one', async () => {
    const t = await seedTenant();
    const expired = await seedContract(t, { status: 'expired' });
    const pausedC = await seedContract(t, { status: 'paused', name: 'Paused' });
    await seedDeliverable(t, { contractId: expired });
    await seedDeliverable(t, { contractId: pausedC });
    await seedDeliverable(t);
    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ deliverables: 3, materialized: 3, opened: 3, failed: 0 });
  });

  runDb('activating a draft re-bases deliverables with no occurrences onto the start, and leaves ones with occurrences alone', async () => {
    const t = await seedTenant();
    // Template applied while the provisional start was 10-01; the real start is 11-01.
    const contractId = await seedContract(t, { startDate: '2026-11-01' });
    const oneTime = await seedDeliverable(t, { contractId, cadence: 'one_time', anchorDueDate: '2026-10-01', effectiveFrom: '2026-10-01' });
    const offsetOneTime = await seedDeliverable(t, { contractId, cadence: 'one_time', anchorDueDate: '2026-10-15', effectiveFrom: '2026-10-01' });
    const quarterly = await seedDeliverable(t, { contractId, cadence: 'quarterly', anchorDueDate: '2026-12-31', effectiveFrom: '2026-10-01' });
    const started = await seedDeliverable(t, { contractId });
    await getTestDb().insert(serviceDeliverableOccurrences).values({
      orgId: t.orgId, deliverableId: started, nameSnapshot: 'x', periodStart: '2026-10-01', periodEnd: '2026-10-31',
      dueAt: '2026-10-31', originalDueAt: '2026-10-31', status: 'scheduled',
    });
    // A deliverable on ANOTHER contract of the same org is never touched.
    const otherContract = await seedContract(t, { name: 'Other', startDate: '2026-11-01' });
    const elsewhere = await seedDeliverable(t, { contractId: otherContract, cadence: 'one_time', anchorDueDate: '2026-10-01', effectiveFrom: '2026-10-01' });

    await system(() => activateContract(contractId, actorOf(t), AS_OF));

    expect(await schedule(oneTime)).toEqual({ effectiveFrom: '2026-11-01', anchorDueDate: '2026-11-01' });
    expect(await schedule(offsetOneTime)).toEqual({ effectiveFrom: '2026-11-01', anchorDueDate: '2026-11-15' });
    expect(await schedule(quarterly)).toEqual({ effectiveFrom: '2026-11-01', anchorDueDate: '2027-01-31' });
    expect(await schedule(started)).toEqual({ effectiveFrom: '2026-10-01', anchorDueDate: '2026-10-31' });
    expect(await schedule(elsewhere)).toEqual({ effectiveFrom: '2026-10-01', anchorDueDate: '2026-10-01' });
  });

  runDb('activating a draft whose start already passed re-bases onto the activation day — nothing is born missed', async () => {
    const t = await seedTenant();
    const contractId = await seedContract(t, { startDate: '2026-09-01' });
    const oneTime = await seedDeliverable(t, { contractId, cadence: 'one_time', anchorDueDate: '2026-09-01', effectiveFrom: '2026-09-01' });
    const monthly = await seedDeliverable(t, { contractId, cadence: 'monthly', anchorDueDate: '2026-09-30', effectiveFrom: '2026-09-01' });

    await system(() => activateContract(contractId, actorOf(t), AS_OF));
    expect(await schedule(oneTime)).toEqual({ effectiveFrom: TODAY, anchorDueDate: TODAY });
    expect(await schedule(monthly)).toEqual({ effectiveFrom: TODAY, anchorDueDate: '2026-11-24' });

    const res = await runDeliverableSweep(AS_OF);
    expect(res.missed).toBe(0);
    const [occ] = await occurrencesOf(oneTime);
    expect(occ).toMatchObject({ status: 'open', dueAt: TODAY });
    expect(await occurrencesOf(monthly)).toHaveLength(0);   // first due 11-24, outside the 7-day lead window
  });

  runDb('changing a draft\'s start date re-bases its unmaterialized deliverables', async () => {
    const t = await seedTenant();
    const contractId = await seedContract(t);
    const d = await seedDeliverable(t, { contractId, cadence: 'one_time', anchorDueDate: '2026-10-01', effectiveFrom: '2026-10-01' });
    await system(() => updateContract(contractId, { startDate: '2026-12-01' }, actorOf(t)));
    expect(await schedule(d)).toEqual({ effectiveFrom: '2026-12-01', anchorDueDate: '2026-12-01' });
    // An edit that leaves the start alone does not move anything.
    await getTestDb().update(serviceDeliverables).set({ effectiveFrom: '2026-12-05', anchorDueDate: '2026-12-05' }).where(eq(serviceDeliverables.id, d));
    await system(() => updateContract(contractId, { name: 'Renamed' }, actorOf(t)));
    expect(await schedule(d)).toEqual({ effectiveFrom: '2026-12-05', anchorDueDate: '2026-12-05' });
  });

  runDb('replaying contract.activated is idempotent, and a pause/resume never re-bases a live contract\'s deliverables', async () => {
    const t = await seedTenant();
    const contractId = await seedContract(t, { startDate: '2026-11-01' });
    const d = await seedDeliverable(t, { contractId, cadence: 'one_time', anchorDueDate: '2026-10-01', effectiveFrom: '2026-10-01' });
    await system(() => activateContract(contractId, actorOf(t), AS_OF));
    const afterActivate = await schedule(d);
    expect(afterActivate).toEqual({ effectiveFrom: '2026-11-01', anchorDueDate: '2026-11-01' });

    const event = { type: 'contract.activated' as const, contractId, orgId: t.orgId, partnerId: t.partnerId };
    await handleContractEvent(event, AS_OF);
    await handleContractEvent(event, AS_OF);
    expect(await schedule(d)).toEqual(afterActivate);

    // Added mid-contract with its own start and no occurrence yet (annual, first due a year out).
    const midTerm = await seedDeliverable(t, { contractId, cadence: 'annual', anchorDueDate: '2027-11-19', effectiveFrom: '2026-11-20' });
    await system(() => pauseContract(contractId, actorOf(t)));
    await system(() => resumeContract(contractId, actorOf(t), '2026-11-25'));   // emits contract.activated too
    await handleContractEvent(event, AS_OF);
    expect(await schedule(midTerm)).toEqual({ effectiveFrom: '2026-11-20', anchorDueDate: '2027-11-19' });
    expect(await schedule(d)).toEqual(afterActivate);
  });
});
