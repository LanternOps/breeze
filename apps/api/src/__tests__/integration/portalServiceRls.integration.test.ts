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
