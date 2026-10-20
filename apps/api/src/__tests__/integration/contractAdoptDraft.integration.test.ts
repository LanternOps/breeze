/**
 * #9346 — fold a hand-built draft contract (Y) into the contract a quote accept
 * created (X): Y's deliverables move onto X, Y's signed agreements and
 * agreement requests are re-linked to X, Y is deleted. All or nothing.
 *
 * Real Postgres + breeze_app role. Runs inside a PARTNER-scoped access context
 * that can see BOTH of the partner's orgs — the realistic MSP tech — so the
 * "another org's draft is 404 and nothing changes" case is carried by the
 * service's own same-org check, not by RLS alone. A second case uses another
 * partner's draft, which RLS hides outright.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  agreementRequests, contracts, contractDocuments, contractLines, contractTemplates, contractTemplateVersions,
  organizations, serviceDeliverableOccurrences, serviceDeliverables,
} from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';
import type { ContractActorT } from '../../services/contractService';
import { adoptDraftContract } from '../../services/contractAdoptService';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Tenant { orgA: string; orgB: string; otherPartnerOrg: string; actor: ContractActorT; ctx: DbAccessContext }

async function seedTenant(): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const accessible = [orgA.id, orgB.id];
    return {
      orgA: orgA.id, orgB: orgB.id, otherPartnerOrg: otherOrg.id,
      actor: { userId: null as unknown as string, partnerId: partner.id, accessibleOrgIds: accessible },
      ctx: {
        scope: 'partner', orgId: null, accessibleOrgIds: accessible, accessiblePartnerIds: [partner.id],
        currentPartnerId: partner.id, userId: null,
      } as never,
    };
  });
}

async function seedContract(orgId: string, name: string, status: 'draft' | 'active' | 'paused' | 'cancelled' = 'draft'): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId));
    const [row] = await db.insert(contracts).values({
      partnerId: org!.partnerId, orgId, name, status, billingTiming: 'advance',
      intervalMonths: 1, startDate: '2026-10-01', currencyCode: 'USD',
    }).returning({ id: contracts.id });
    await db.insert(contractLines).values({
      contractId: row!.id, orgId, lineType: 'flat', description: `${name} line`, unitPrice: '100.00',
    } as never);
    return row!.id;
  });
}

async function seedTemplate(orgId: string): Promise<{ templateId: string; versionId: string }> {
  return withSystemDbAccessContext(async () => {
    const [template] = await db.insert(contractTemplates)
      .values({ orgId, partnerId: null, name: `MSA ${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: contractTemplates.id });
    const [version] = await db.insert(contractTemplateVersions).values({
      templateId: template!.id, orgId, partnerId: null, versionNumber: 1, status: 'published',
      sourceType: 'authored', bodyHtml: '<p>x</p>', sha256: 'c'.repeat(64), declaredVariables: [], publishedAt: new Date(),
    }).returning({ id: contractTemplateVersions.id });
    return { templateId: template!.id, versionId: version!.id };
  });
}

async function seedSignedAgreement(orgId: string, contractId: string): Promise<string> {
  const { templateId, versionId } = await seedTemplate(orgId);
  return withSystemDbAccessContext(async () => {
    const [doc] = await db.insert(contractDocuments).values({
      orgId, contractId, templateId, templateVersionId: versionId,
      pdfData: Buffer.from('pdf'), byteSize: 3, sha256: 'd'.repeat(64),
    }).returning({ id: contractDocuments.id });
    return doc!.id;
  });
}

async function seedAgreementRequest(orgId: string, contractId: string): Promise<string> {
  const { templateId, versionId } = await seedTemplate(orgId);
  return withSystemDbAccessContext(async () => {
    const [req] = await db.insert(agreementRequests).values({
      orgId, contractId, templateId, templateVersionId: versionId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    }).returning({ id: agreementRequests.id });
    return req!.id;
  });
}

async function seedDeliverable(orgId: string, contractId: string, name: string, active = true): Promise<{ id: string; occurrenceId: string }> {
  return withSystemDbAccessContext(async () => {
    const [d] = await db.insert(serviceDeliverables).values({
      orgId, contractId, name, cadence: 'monthly', anchorDueDate: '2026-11-01', effectiveFrom: '2026-10-01', active,
    }).returning({ id: serviceDeliverables.id });
    const [o] = await db.insert(serviceDeliverableOccurrences).values({
      orgId, deliverableId: d!.id, nameSnapshot: name, periodStart: '2026-10-01', periodEnd: '2026-10-31',
      dueAt: '2026-10-31', originalDueAt: '2026-10-31', status: 'delivered', deliveredAt: new Date('2026-10-20T00:00:00Z'),
      deliveredVia: 'explicit', deliveryNote: 'done',
    }).returning({ id: serviceDeliverableOccurrences.id });
    return { id: d!.id, occurrenceId: o!.id };
  });
}

/** Everything the adopt could touch, read with system scope. */
async function snapshot(contractIds: string[]) {
  return withSystemDbAccessContext(async () => ({
    contracts: await db.select({ id: contracts.id, status: contracts.status }).from(contracts)
      .where(inArray(contracts.id, contractIds)).orderBy(contracts.id),
    deliverables: await db.select({ id: serviceDeliverables.id, contractId: serviceDeliverables.contractId, name: serviceDeliverables.name })
      .from(serviceDeliverables).orderBy(serviceDeliverables.id),
    occurrences: await db.select().from(serviceDeliverableOccurrences).orderBy(serviceDeliverableOccurrences.id),
    documents: await db.select({ id: contractDocuments.id, contractId: contractDocuments.contractId })
      .from(contractDocuments).orderBy(contractDocuments.id),
    requests: await db.select({ id: agreementRequests.id, contractId: agreementRequests.contractId })
      .from(agreementRequests).orderBy(agreementRequests.id),
    lines: await db.select({ id: contractLines.id, contractId: contractLines.contractId }).from(contractLines)
      .where(inArray(contractLines.contractId, contractIds)).orderBy(contractLines.id),
  }));
}

describe('adoptDraftContract (#9346)', () => {
  runDb('moves every deliverable, re-links documents and requests, deletes the draft; occurrences untouched', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'Quote accept draft');
    const y = await seedContract(t.orgA, 'Hand-built draft');
    const d1 = await seedDeliverable(t.orgA, y, 'Quarterly review');
    const d2 = await seedDeliverable(t.orgA, y, 'Retired report', false);
    const xOwn = await seedDeliverable(t.orgA, x, 'Monthly patch report');
    const docY = await seedSignedAgreement(t.orgA, y);
    const docX = await seedSignedAgreement(t.orgA, x);
    const reqY = await seedAgreementRequest(t.orgA, y);
    const before = await snapshot([x, y]);

    const res = await withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor));

    expect(res).toMatchObject({
      target: { id: x, orgId: t.orgA, name: 'Quote accept draft' },
      source: { id: y, orgId: t.orgA, name: 'Hand-built draft' },
      movedDeliverables: 2, movedDocuments: 1, movedAgreementRequests: 1,
    });
    const after = await snapshot([x, y]);
    expect(after.contracts).toEqual([{ id: x, status: 'draft' }]);
    const byId = new Map(after.deliverables.map((d) => [d.id, d.contractId]));
    expect(byId.get(d1.id)).toBe(x);
    expect(byId.get(d2.id)).toBe(x);
    expect(byId.get(xOwn.id)).toBe(x);
    expect(after.documents).toEqual(expect.arrayContaining([{ id: docY, contractId: x }, { id: docX, contractId: x }]));
    expect(after.requests).toEqual([{ id: reqY, contractId: x }]);
    // Occurrence history is byte-for-byte unchanged.
    expect(after.occurrences).toEqual(before.occurrences);
    // Source lines are NOT copied: X keeps only its own line; Y's cascaded away.
    expect(after.lines.map((l) => l.contractId)).toEqual([x]);
  });

  runDb('adopts into an ACTIVE target', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'Active', 'active');
    const y = await seedContract(t.orgA, 'Draft');
    await seedDeliverable(t.orgA, y, 'Review');
    const res = await withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor));
    expect(res.movedDeliverables).toBe(1);
    expect((await snapshot([x, y])).contracts).toEqual([{ id: x, status: 'active' }]);
  });

  runDb('409 DUPLICATE_NAME on a name collision and nothing changes', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X');
    const y = await seedContract(t.orgA, 'Y');
    await seedDeliverable(t.orgA, x, 'Quarterly review');
    await seedDeliverable(t.orgA, y, 'Quarterly review');
    await seedDeliverable(t.orgA, y, 'Unique one');
    await seedSignedAgreement(t.orgA, y);
    const before = await snapshot([x, y]);

    await expect(withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor)))
      .rejects.toMatchObject({ status: 409, code: 'DUPLICATE_NAME', details: { names: ['Quarterly review'] } });
    expect(await snapshot([x, y])).toEqual(before);
  });

  runDb('400 when the source is not a draft, and nothing changes', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X');
    const y = await seedContract(t.orgA, 'Y', 'active');
    await seedDeliverable(t.orgA, y, 'Review');
    const before = await snapshot([x, y]);
    await expect(withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor)))
      .rejects.toMatchObject({ status: 400, code: 'ADOPT_SOURCE_NOT_DRAFT' });
    expect(await snapshot([x, y])).toEqual(before);
  });

  runDb('400 when the target is neither draft nor active', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X', 'cancelled');
    const y = await seedContract(t.orgA, 'Y');
    await expect(withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor)))
      .rejects.toMatchObject({ status: 400, code: 'ADOPT_TARGET_INVALID_STATE' });
    expect((await snapshot([x, y])).contracts).toHaveLength(2);
  });

  runDb('400 when a contract is asked to adopt itself', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X');
    await expect(withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: x }, t.actor)))
      .rejects.toMatchObject({ status: 400, code: 'ADOPT_SELF' });
    expect((await snapshot([x])).contracts).toEqual([{ id: x, status: 'draft' }]);
  });

  runDb('404 for a draft in a sister org the caller CAN see, and nothing changes (cross-org)', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X');
    const y = await seedContract(t.orgB, 'Sister org draft');
    await seedDeliverable(t.orgB, y, 'Review');
    await seedSignedAgreement(t.orgB, y);
    const before = await snapshot([x, y]);
    await expect(withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor)))
      .rejects.toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(await snapshot([x, y])).toEqual(before);
  });

  runDb('404 for another partner\'s draft (RLS-hidden), and nothing changes (cross-tenant)', async () => {
    const t = await seedTenant();
    const x = await seedContract(t.orgA, 'X');
    const y = await seedContract(t.otherPartnerOrg, 'Other partner draft');
    await seedDeliverable(t.otherPartnerOrg, y, 'Review');
    const before = await snapshot([x, y]);
    await expect(withDbAccessContext(t.ctx, () => adoptDraftContract(x, { sourceContractId: y }, t.actor)))
      .rejects.toMatchObject({ status: 404, code: 'CONTRACT_NOT_FOUND' });
    expect(await snapshot([x, y])).toEqual(before);
  });
});
