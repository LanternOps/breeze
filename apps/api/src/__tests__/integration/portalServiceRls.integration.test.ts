import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  contracts, orgDocuments, organizationKeyDates, portalBranding, reports, reportRuns,
  serviceDeliverableEvidence, serviceDeliverableOccurrences, serviceDeliverables,
} from '../../db/schema';
import {
  deliverableOccurrences, serviceOverview, serviceTile,
} from '../../services/portal/serviceReadModel';
import {
  documentsForOrg, portalVisibleDocument,
} from '../../services/portal/documentsReadModel';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const NOW = new Date('2026-10-15T12:00:00Z');
const ARGS = { timezone: 'UTC', now: NOW };

/** Everything one org needs to be visible on the portal Service page. */
async function seedOrgService(
  admin: ReturnType<typeof getTestDb>, orgId: string, partnerId: string, label: string,
) {
  await admin.insert(portalBranding).values({
    orgId, enableService: true, enableDocuments: true, enableReports: true,
  });
  const [contract] = await admin.insert(contracts).values({
    partnerId, orgId, name: `${label} plan`, status: 'active', intervalMonths: 12,
    startDate: '2026-01-01', endDate: '2027-01-01', currencyCode: 'USD',
  }).returning({ id: contracts.id });
  const [deliverable] = await admin.insert(serviceDeliverables).values({
    orgId, contractId: contract!.id, name: `${label} sign-in log review`,
    cadence: 'monthly', anchorDueDate: '2026-09-30', effectiveFrom: '2026-01-01',
    artifactRequired: true, portalVisible: true,
  }).returning({ id: serviceDeliverables.id });
  const [occurrence] = await admin.insert(serviceDeliverableOccurrences).values({
    orgId, deliverableId: deliverable!.id, nameSnapshot: `${label} sign-in log review`,
    periodStart: '2026-09-01', periodEnd: '2026-09-30', dueAt: '2026-09-30',
    originalDueAt: '2026-09-30', status: 'delivered',
    deliveredAt: new Date('2026-09-29T12:00:00Z'), deliveryNote: `${label} note`,
  }).returning({ id: serviceDeliverableOccurrences.id });
  const [doc] = await admin.insert(orgDocuments).values({
    orgId, title: `${label} findings`, category: 'evidence', storageBackend: 'db',
    data: Buffer.from(label), contentType: 'application/pdf', byteSize: label.length,
    sha256: 'a'.repeat(64), originalFilename: `${label}.pdf`, portalVisible: true,
  }).returning({ id: orgDocuments.id });
  await admin.insert(serviceDeliverableEvidence).values({
    orgId, occurrenceId: occurrence!.id, kind: 'document', documentId: doc!.id,
  });
  await admin.insert(organizationKeyDates).values({
    orgId, label: `${label} insurance renewal`, kind: 'insurance_renewal',
    date: '2027-06-01', portalVisible: true,
  });
  return {
    contractId: contract!.id, deliverableId: deliverable!.id,
    occurrenceId: occurrence!.id, documentId: doc!.id,
  };
}

function portalContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization', orgId, accessibleOrgIds: [orgId],
    accessiblePartnerIds: [], userId: null, currentPartnerId: null,
  };
}

describe('portal service RLS', () => {
  it("shows organization A its own service record and none of organization B's", async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const a = await seedOrgService(admin, orgA.id, partner.id, 'alpha');
    const b = await seedOrgService(admin, orgB.id, partner.id, 'bravo');

    await withDbAccessContext(portalContext(orgA.id), async () => {
      const overview = await serviceOverview(orgA.id, ARGS);
      const serialized = JSON.stringify(overview);

      // Positive control FIRST: without it, a broken query passes every
      // negative assertion below by returning nothing.
      expect(serialized).toContain('alpha sign-in log review');
      expect(serialized).toContain('alpha findings');
      expect(serialized).toContain('alpha insurance renewal');
      expect(overview.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('attached');

      expect(serialized).not.toContain('bravo');
      expect(serialized).not.toMatch(/ticket/i);

      // A forged read of B's own org id under A's context sees nothing: RLS,
      // not an app-layer filter, is what stops it.
      expect((await serviceOverview(orgB.id, ARGS)).groups).toEqual([]);

      // B's deliverable id is indistinguishable from a non-existent one.
      await expect(deliverableOccurrences(orgA.id, b.deliverableId, ARGS)).resolves.toBeNull();
      const own = await deliverableOccurrences(orgA.id, a.deliverableId, ARGS);
      expect(own!.occurrences).toHaveLength(1);
      expect(own!.occurrences[0]!.evidence.map((e) => e.kind)).toEqual(['document']);
      expect(JSON.stringify(own)).not.toMatch(/ticket/i);

      const docs = await documentsForOrg(orgA.id, ARGS);
      expect(JSON.stringify(docs)).toContain('alpha findings');
      expect(JSON.stringify(docs)).not.toContain('bravo');
      await expect(portalVisibleDocument(orgA.id, b.documentId)).resolves.toBeNull();
      await expect(portalVisibleDocument(orgA.id, a.documentId))
        .resolves.toMatchObject({ id: a.documentId });

      const tile = await serviceTile(orgA.id, ARGS);
      expect(tile).toMatchObject({ status: 'ok', deliveredOnTime: 1, deliveredLate: 0, missed: 0 });
    });
  });

  it('withholds a report run whose definition is not portal self-service', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const staff = await createUser({ partnerId: partner.id, orgId: null });
    const seeded = await seedOrgService(admin, org.id, partner.id, 'charlie');

    const [internal] = await admin.insert(reports).values({
      orgId: org.id, name: 'Internal posture', type: 'security_compliance_posture',
      portalSelfService: false, createdBy: staff.id,
    }).returning({ id: reports.id });
    const [run] = await admin.insert(reportRuns).values({
      reportId: internal!.id, status: 'completed', completedAt: new Date(),
    }).returning({ id: reportRuns.id });
    await admin.insert(serviceDeliverableEvidence).values({
      orgId: org.id, occurrenceId: seeded.occurrenceId, kind: 'report_run',
      reportId: internal!.id, reportRunId: run!.id,
    });

    await withDbAccessContext(portalContext(org.id), async () => {
      const overview = await serviceOverview(org.id, ARGS);
      const evidence = overview.groups[0]!.deliverables[0]!.lastDelivered!.evidence;
      // The document evidence still publishes; the internal run does not.
      expect(evidence.map((e) => e.kind)).toEqual(['document']);
      expect(JSON.stringify(overview)).not.toContain(run!.id);
    });
  });

  it('publishes evidence documents even with enable_documents off', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedOrgService(admin, org.id, partner.id, 'delta');
    await admin.update(portalBranding).set({ enableDocuments: false })
      .where(eq(portalBranding.orgId, org.id));

    await withDbAccessContext(portalContext(org.id), async () => {
      const overview = await serviceOverview(org.id, ARGS);
      expect(overview.groups[0]!.deliverables[0]!.lastDelivered!.artifactState).toBe('attached');
    });
  });

  it('hides a document the MSP has not marked portal-visible', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const seeded = await seedOrgService(admin, org.id, partner.id, 'echo');
    await admin.update(orgDocuments).set({ portalVisible: false })
      .where(eq(orgDocuments.id, seeded.documentId));

    await withDbAccessContext(portalContext(org.id), async () => {
      const overview = await serviceOverview(org.id, ARGS);
      const last = overview.groups[0]!.deliverables[0]!.lastDelivered!;
      // Positive control: the delivery record itself still publishes.
      expect(last.note).toBe('echo note');
      expect(last.evidence).toEqual([]);
      expect(last.artifactState).toBe('held_by_msp');

      expect((await documentsForOrg(org.id, ARGS)).groups).toEqual([]);
      await expect(portalVisibleDocument(org.id, seeded.documentId)).resolves.toBeNull();
    });
  });

  it('publishes only the newest 24 occurrences, newest first', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const seeded = await seedOrgService(admin, org.id, partner.id, 'golf');

    // 30 more periods, oldest first: 2025-01 .. 2027-06.
    const extra = Array.from({ length: 30 }, (_, i) => {
      const month = i + 1;
      const year = 2024 + Math.floor(month / 12);
      const mm = String((month % 12) + 1).padStart(2, '0');
      return {
        orgId: org.id,
        deliverableId: seeded.deliverableId,
        nameSnapshot: 'golf sign-in log review',
        periodStart: `${year}-${mm}-01`,
        periodEnd: `${year}-${mm}-28`,
        dueAt: `${year}-${mm}-28`,
        originalDueAt: `${year}-${mm}-28`,
        status: 'scheduled' as const,
      };
    });
    await admin.insert(serviceDeliverableOccurrences).values(extra);

    await withDbAccessContext(portalContext(org.id), async () => {
      const dto = await deliverableOccurrences(org.id, seeded.deliverableId, ARGS);
      expect(dto!.occurrences).toHaveLength(24);
      const dueDates = dto!.occurrences.map((o) => o.dueAt);
      // Newest first, and the window really is the newest 24 of the 31 rows.
      expect([...dueDates].sort().reverse()).toEqual(dueDates);
      // The seeded delivered occurrence is the newest of the 31 rows, and the
      // oldest generated period falls outside the window.
      expect(dueDates[0]).toBe('2026-09-30');
      expect(dueDates).not.toContain('2024-02-28');

      // A caller asking for more than the published window still gets 24.
      const greedy = await deliverableOccurrences(org.id, seeded.deliverableId, { ...ARGS, limit: 999 });
      expect(greedy!.occurrences).toHaveLength(24);
    });
  });

  it('lists the newest PORTAL-VISIBLE version of a superseded document chain', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const seeded = await seedOrgService(admin, org.id, partner.id, 'hotel');

    // A draft replacement the MSP has not published yet must NOT hide the
    // version the customer can still read.
    const [draft] = await admin.insert(orgDocuments).values({
      orgId: org.id, title: 'hotel findings v2 (draft)', category: 'evidence',
      storageBackend: 'db', data: Buffer.from('v2'), contentType: 'application/pdf',
      byteSize: 2, sha256: 'b'.repeat(64), originalFilename: 'hotel-v2.pdf',
      portalVisible: false, supersedesDocumentId: seeded.documentId,
    }).returning({ id: orgDocuments.id });

    await withDbAccessContext(portalContext(org.id), async () => {
      const docs = await documentsForOrg(org.id, ARGS);
      const titles = docs.groups.flatMap((g) => g.documents.map((d) => d.title));
      expect(titles).toContain('hotel findings');
      expect(titles).not.toContain('hotel findings v2 (draft)');
    });

    // Publish the replacement: now the OLD version drops out of the library
    // (it stays reachable by id, which is what a delivery record links to).
    await admin.update(orgDocuments).set({ portalVisible: true })
      .where(eq(orgDocuments.id, draft!.id));

    await withDbAccessContext(portalContext(org.id), async () => {
      const docs = await documentsForOrg(org.id, ARGS);
      const titles = docs.groups.flatMap((g) => g.documents.map((d) => d.title));
      expect(titles).toContain('hotel findings v2 (draft)');
      expect(titles).not.toContain('hotel findings');
      await expect(portalVisibleDocument(org.id, seeded.documentId))
        .resolves.toMatchObject({ id: seeded.documentId });
    });
  });

  it('counts a late-evening delivery as on time in the org timezone', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const seeded = await seedOrgService(admin, org.id, partner.id, 'india');

    // 2026-09-30 23:30 America/Los_Angeles = 2026-10-01 06:30Z. The customer's
    // calendar says on time; a bare ::date cast in the session zone says late.
    await admin.update(serviceDeliverableOccurrences)
      .set({ deliveredAt: new Date('2026-10-01T06:30:00Z') })
      .where(eq(serviceDeliverableOccurrences.id, seeded.occurrenceId));

    await withDbAccessContext(portalContext(org.id), async () => {
      const tile = await serviceTile(org.id, { timezone: 'America/Los_Angeles', now: NOW });
      expect(tile).toMatchObject({ deliveredOnTime: 1, deliveredLate: 0 });
      // Positive control: read in UTC, the same row IS late.
      const utc = await serviceTile(org.id, { timezone: 'UTC', now: NOW });
      expect(utc).toMatchObject({ deliveredOnTime: 0, deliveredLate: 1 });
    });
  });

  it('returns no tile at all when enable_service is off', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await seedOrgService(admin, org.id, partner.id, 'foxtrot');

    await withDbAccessContext(portalContext(org.id), async () => {
      // Positive control: on, the tile exists for this same data.
      await expect(serviceTile(org.id, ARGS)).resolves.toMatchObject({ status: 'ok' });
    });

    await admin.update(portalBranding).set({ enableService: false })
      .where(eq(portalBranding.orgId, org.id));

    await withDbAccessContext(portalContext(org.id), async () => {
      await expect(serviceTile(org.id, ARGS)).resolves.toBeNull();
    });
  });
});
