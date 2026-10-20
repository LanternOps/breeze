/**
 * #9303 — a contract's detail read names the org's OTHER live contracts, so a
 * second contract for the same services (a quote-accept draft next to a
 * hand-built one) is visible before both are activated.
 *
 * Real Postgres + breeze_app role. The detail read runs inside a PARTNER-scoped
 * access context that can see BOTH of the partner's orgs — the realistic MSP
 * tech — so the "never another org's contracts" assertion is not carried by RLS
 * alone: the service must filter to the viewed contract's org itself.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  contracts, contractDocuments, contractTemplates, contractTemplateVersions, organizations, serviceDeliverables,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import { addContractLineToContract, createContract, getContract, type ContractActorT } from '../../services/contractService';
import { createQuote, addManualLine } from '../../services/quoteService';
import { sendQuote } from '../../services/quoteLifecycle';
import { acceptQuote } from '../../services/quoteAcceptService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const partnerCtx = (partnerId: string, orgIds: string[]): DbAccessContext =>
  ({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null }) as never;

interface Tenant { partnerId: string; orgA: string; orgB: string; otherPartnerOrg: string; actor: ContractActorT; ctx: DbAccessContext }

async function seedTenant(): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const accessible = [orgA.id, orgB.id];
    return {
      partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, otherPartnerOrg: otherOrg.id,
      actor: { userId: null as unknown as string, partnerId: partner.id, accessibleOrgIds: accessible },
      ctx: partnerCtx(partner.id, accessible),
    };
  });
}

async function seedContract(orgId: string, name: string, opts: {
  intervalMonths?: number; startDate?: string; endDate?: string | null; status?: 'draft' | 'active' | 'paused' | 'cancelled' | 'expired';
  flatPrice?: string;
} = {}): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId));
    const [row] = await db.insert(contracts).values({
      partnerId: org!.partnerId, orgId, name, status: opts.status ?? 'draft', billingTiming: 'advance',
      intervalMonths: opts.intervalMonths ?? 1, startDate: opts.startDate ?? '2026-10-01',
      endDate: opts.endDate ?? null, currencyCode: 'USD',
    }).returning({ id: contracts.id });
    return row!.id;
  });
}

async function seedSignedAgreement(orgId: string, contractId: string): Promise<void> {
  await withSystemDbAccessContext(async () => {
    const [template] = await db.insert(contractTemplates)
      .values({ orgId, partnerId: null, name: `MSA ${contractId.slice(0, 6)}` })
      .returning({ id: contractTemplates.id });
    const [version] = await db.insert(contractTemplateVersions).values({
      templateId: template!.id, orgId, partnerId: null, versionNumber: 1, status: 'published',
      sourceType: 'authored', bodyHtml: '<p>x</p>', sha256: 'c'.repeat(64), declaredVariables: [], publishedAt: new Date(),
    }).returning({ id: contractTemplateVersions.id });
    await db.insert(contractDocuments).values({
      orgId, contractId, templateId: template!.id, templateVersionId: version!.id,
      pdfData: Buffer.from('pdf'), byteSize: 3, sha256: 'd'.repeat(64),
    });
  });
}

async function seedDeliverable(orgId: string, contractId: string, name: string, active = true): Promise<void> {
  await withSystemDbAccessContext(() => db.insert(serviceDeliverables).values({
    orgId, contractId, name, cadence: 'monthly', anchorDueDate: '2026-11-01', effectiveFrom: '2026-10-01', active,
  }));
}

describe('getContract relatedContracts (#9303)', () => {
  runDb('names an overlapping same-org sibling with counts; never self, cancelled, or another org', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'Quote accept draft');
    const y = await seedContract(t.orgA, 'Hand-built draft', { startDate: '2026-09-01' });
    await withSystemDbAccessContext(() => addContractLineToContract(y, {
      lineType: 'flat', description: 'Managed services', unitPrice: '500.00', taxable: false,
    }, { ...t.actor, accessibleOrgIds: null } as ContractActorT));
    await seedDeliverable(t.orgA, y, 'Quarterly review');
    await seedDeliverable(t.orgA, y, 'Monthly patch report');
    await seedDeliverable(t.orgA, y, 'Retired deliverable', false);
    await seedSignedAgreement(t.orgA, y);
    const cancelled = await seedContract(t.orgA, 'Old cancelled', { status: 'cancelled' });
    const expired = await seedContract(t.orgA, 'Old expired', { status: 'expired' });
    // Same partner, other org — VISIBLE to this partner-scoped reader, so only
    // the service's own org filter keeps it out.
    const sameParterOtherOrg = await seedContract(t.orgB, 'Sister org contract');
    const otherPartner = await seedContract(t.otherPartnerOrg, 'Other partner contract');

    const got = await withDbAccessContext(t.ctx, () => getContract(x, t.actor, { includeRelated: true }));
    const related = got.relatedContracts!;
    const ids = related.map((r) => r.id);
    expect(ids).toEqual([y]);
    expect(ids).not.toContain(x);
    expect(ids).not.toContain(cancelled);
    expect(ids).not.toContain(expired);
    expect(ids).not.toContain(sameParterOtherOrg);
    expect(ids).not.toContain(otherPartner);
    expect(related[0]).toEqual({
      id: y, name: 'Hand-built draft', status: 'draft', intervalMonths: 1, currencyCode: 'USD',
      recurringTotal: '500.00', deliverableCount: 2, signedAgreementCount: 1, overlapsCadence: true,
    });
  });

  runDb('flags overlapsCadence false for a different cadence or a non-overlapping term', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'Monthly', { startDate: '2027-01-01' });
    const annual = await seedContract(t.orgA, 'Annual licences', { intervalMonths: 12, status: 'active' });
    const ended = await seedContract(t.orgA, 'Ended last year', { startDate: '2026-01-01', endDate: '2026-12-31', status: 'paused' });

    const got = await withDbAccessContext(t.ctx, () => getContract(x, t.actor, { includeRelated: true }));
    const byId = new Map(got.relatedContracts!.map((r) => [r.id, r]));
    expect(byId.get(annual)).toMatchObject({ status: 'active', overlapsCadence: false, deliverableCount: 0, signedAgreementCount: 0 });
    expect(byId.get(ended)).toMatchObject({ status: 'paused', overlapsCadence: false });
  });

  runDb('returns an empty list when the org has no other live contract', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'Only one');
    await seedContract(t.orgB, 'Sister org contract');
    const got = await withDbAccessContext(t.ctx, () => getContract(x, t.actor, { includeRelated: true }));
    expect(got.relatedContracts).toEqual([]);
  });

  runDb('omits relatedContracts entirely unless asked (AI tools, partner API, generate unchanged)', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X');
    await seedContract(t.orgA, 'Y');
    const got = await withDbAccessContext(t.ctx, () => getContract(x, t.actor));
    expect('relatedContracts' in got).toBe(false);
  });
});

describe('acceptQuote overlappingContracts (#9303)', () => {
  async function seedSentMonthlyQuote(t: Tenant): Promise<string> {
    const ctx: DbAccessContext = { scope: 'organization', orgId: t.orgA, accessibleOrgIds: [t.orgA], accessiblePartnerIds: [t.partnerId], userId: null };
    const actor = { userId: null, partnerId: t.partnerId, accessibleOrgIds: [t.orgA] };
    const q = await withDbAccessContext(ctx, () => createQuote({ orgId: t.orgA, currencyCode: 'USD' }, actor));
    await withDbAccessContext(ctx, () => addManualLine(q.id, {
      sourceType: 'manual', description: 'Managed services', quantity: 1, unitPrice: 500,
      taxable: false, customerVisible: true, recurrence: 'monthly',
    } as never, actor));
    await withDbAccessContext(ctx, () => sendQuote(q.id, actor));
    return q.id;
  }

  runDb('names the org\'s existing same-cadence contract next to the new draft', async () => {
    const t = await seedTenant();
    const existing = await seedContract(t.orgA, 'Hand-built draft', { startDate: '2026-01-01' });
    await seedContract(t.orgA, 'Annual licences', { intervalMonths: 12, startDate: '2026-01-01' });
    await seedContract(t.orgA, 'Cancelled', { status: 'cancelled', startDate: '2026-01-01' });
    await seedContract(t.orgB, 'Sister org draft', { startDate: '2026-01-01' });
    const quoteId = await seedSentMonthlyQuote(t);

    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      acceptQuote({ quoteId, signerName: 'Jane Buyer', origin: 'on_behalf', method: 'verbal', reference: 'call 10-19' })));

    expect(res.contractIds).toHaveLength(1);
    expect(res.overlappingContracts).toEqual([{ id: existing, name: 'Hand-built draft', status: 'draft', intervalMonths: 1 }]);
  });

  runDb('is empty when the org had no same-cadence contract', async () => {
    const t = await seedTenant();
    await seedContract(t.orgA, 'Annual licences', { intervalMonths: 12, startDate: '2026-01-01' });
    const quoteId = await seedSentMonthlyQuote(t);
    const res = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      acceptQuote({ quoteId, signerName: 'Jane Buyer', origin: 'on_behalf', method: 'verbal', reference: 'call 10-19' })));
    expect(res.overlappingContracts).toEqual([]);
    // sanity: the accept really did create its own draft
    const created = await withSystemDbAccessContext(() => db.select().from(contracts).where(eq(contracts.id, res.contractIds[0]!)));
    expect(created[0]!.status).toBe('draft');
  });
});
