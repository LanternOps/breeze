/**
 * Endpoint Management Review evidence — W03 (#5784, #5812 / #5815), proven end
 * to end on real Postgres.
 *
 * W01's `managedEvidenceFoundations.integration.test.ts` had to `vi.mock` the
 * closed registry because it was empty. W03 ships the first REAL entry, so this
 * suite uses no such mock: the template apply, the apply-time provisioning, the
 * sweep, the system execution path, the generator's own reads of the #5327
 * sync tables and the OD-12 publication gate are all the shipped code.
 *
 * The five cases are the wave's load-bearing claims:
 *
 *  1. a partner-wide template produces the artifact — never wired by hand;
 *  2. a PARTIAL snapshot is not fresh (`last_complete_snapshot_at`, never
 *     `last_success_at`);
 *  3. no sync state produces a DATA GAP, not zeros;
 *  4. the unlinked Intune population is COUNTED, never enumerated;
 *  5. OD-12 end to end, including that the server-side `renderRunPdf` path
 *     reaches `buildReportPdf`'s endpoint-management arm rather than degrading
 *     to `renderGenericReport` — asserted by the history caveat being present
 *     in the PDF's text.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  devices, m365Connections, m365IntuneDevices, m365LicenseSkus, m365PostureRollups, m365SyncState,
  portalBranding, reportRuns, reports, serviceDeliverableEvidence,
  serviceDeliverableOccurrences, serviceDeliverables,
} from '../../db/schema';
import {
  assignUserToPartner, createOrganization, createPartner, createRole,
  createSite, createUser, grantRolePermissions,
} from './db-utils';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { applyTemplateSet, createTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';
import { resolveManagedEvidenceDefinition } from '../../services/managedEvidenceDefinitions';
import { deliverOccurrence } from '../../services/serviceDeliverableService';
import {
  PortalReportNotFoundError, listPortalRuns, renderRunPdf,
} from '../../services/portal/reportsSelfService';
import { generateEndpointManagementReport } from '../../services/endpointManagementReport';
import type { EndpointManagementSummary, IntuneDeviceRow } from '@breeze/shared';
import type { OrgReportExecutionAuthority } from '../../services/siteScope';
import { siteScopeFingerprint } from '../../services/siteScope';

// publishEvent writes to a Redis stream — spy on it (deliverableSweep precedent).
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);
const TYPE = 'endpoint_management_review' as const;
const DUE = '2026-10-31';
const AS_OF = new Date('2026-10-31T05:18:00Z');
const system = <T>(fn: () => Promise<T>, label = 'endpointManagement.integration') =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

// The wave is INERT without this flag: with it off the generator correctly
// renders a data-gap page, which would make cases 1, 2, 4 and 5 pass vacuously.
let priorFlag: string | undefined;
beforeAll(() => {
  priorFlag = process.env.M365_TENANT_SYNC_ENABLED;
  process.env.M365_TENANT_SYNC_ENABLED = 'true';
});
afterAll(() => {
  if (priorFlag === undefined) delete process.env.M365_TENANT_SYNC_ENABLED;
  else process.env.M365_TENANT_SYNC_ENABLED = priorFlag;
});

interface Tenant {
  partnerId: string; orgId: string; techId: string; siteAId: string; siteBId: string;
  connectionId: string; m365TenantId: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: org.id, name: 'Site A' });
  const siteB = await createSite({ orgId: org.id, name: 'Site B' });
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [
    { resource: 'tickets', action: 'read' }, { resource: 'tickets', action: 'write' },
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
    { resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' },
  ]);
  const tech = (await createUser({
    partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech',
  }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');

  // m365_sync_state carries a composite (connection_id, org_id) FK, so a real
  // connection row is required before any sync state exists. Shape copied from
  // m365SyncClaim.integration.test.ts, including the consent attempt id both
  // CHECK constraints demand on the customer-graph-read profile.
  const m365TenantId = randomUUID();
  const [connection] = await getTestDb().insert(m365Connections).values({
    orgId: org.id,
    userId: null,
    tenantId: m365TenantId,
    clientId: randomUUID(),
    clientSecret: null,
    profile: 'customer-graph-read',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${org.id}/v1`,
    credentialVersion: 'v1',
    permissionManifestVersion: 3,
    consentAttemptId: randomUUID(),
    consentGeneration: 2,
    status: 'active',
  }).returning({ id: m365Connections.id });

  return {
    partnerId: partner.id, orgId: org.id, techId: tech.id,
    siteAId: siteA.id, siteBId: siteB.id,
    connectionId: connection!.id, m365TenantId,
  };
}

const actorFor = (t: Tenant): TemplateActor => ({
  userId: t.techId, scope: 'partner', partnerId: t.partnerId, partnerOrgAccess: 'all',
  accessibleOrgIds: [t.orgId],
});

function authority(orgId: string, userId: string, siteIds?: string[]): OrgReportExecutionAuthority {
  const scope = siteIds
    ? { version: 1 as const, kind: 'restricted' as const, orgId, siteIds }
    : { version: 1 as const, kind: 'unrestricted' as const, orgId };
  return {
    principalKind: 'user', scope, principalUserId: userId,
    capturedAt: AS_OF, fingerprint: siteScopeFingerprint(scope),
  };
}

/** A COMPLETE snapshot: fresh, untruncated, primary source ok. */
async function seedSyncState(t: Tenant, over: Partial<typeof m365SyncState.$inferInsert> = {}) {
  await getTestDb().insert(m365SyncState).values({
    orgId: t.orgId,
    connectionId: t.connectionId,
    domain: 'intune_devices',
    intervalSeconds: 6 * 3600,
    lastRunAt: AS_OF,
    lastSuccessAt: AS_OF,
    lastCompleteSnapshotAt: AS_OF,
    lastStatus: 'success',
    truncated: false,
    sources: { managedDevices: 'ok' },
    ...over,
  });
}

async function seedSkuState(t: Tenant) {
  await getTestDb().insert(m365SyncState).values({
    orgId: t.orgId, connectionId: t.connectionId, domain: 'skus', intervalSeconds: 24 * 3600,
    lastRunAt: AS_OF, lastSuccessAt: AS_OF, lastCompleteSnapshotAt: AS_OF,
    lastStatus: 'success', truncated: false, sources: { subscribedSkus: 'ok' },
  });
}

async function seedIntuneDevice(
  orgId: string,
  over: Partial<typeof m365IntuneDevices.$inferInsert> = {},
) {
  const [row] = await getTestDb().insert(m365IntuneDevices).values({
    orgId,
    graphId: randomUUID(),
    coreHash: 'a'.repeat(64),
    deviceName: `LT-${randomUUID().slice(0, 4)}`,
    operatingSystem: 'Windows',
    osVersion: '10.0.22631',
    complianceState: 'compliant',
    lastIntuneSyncAt: AS_OF,
    userPrincipalName: 'sam@acme.test',
    ownerType: 'company',
    jailBroken: 'Unknown',
    ...over,
  }).returning({ id: m365IntuneDevices.id });
  return row!.id;
}

/** db-utils has no device helper; this is the shape every integration suite
 *  inserts by hand (see agentHealthObservations.integration.test.ts). */
async function createDevice(args: { orgId: string; siteId: string }) {
  const [row] = await getTestDb().insert(devices).values({
    orgId: args.orgId,
    siteId: args.siteId,
    agentId: `epm-${randomUUID()}`,
    hostname: `epm-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '0.99.0',
    status: 'online',
  }).returning({ id: devices.id });
  return row!;
}

const occurrencesOf = (deliverableId: string) => getTestDb().select().from(serviceDeliverableOccurrences)
  .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId)).orderBy(serviceDeliverableOccurrences.dueAt);
const evidenceOf = (occurrenceId: string) => getTestDb().select().from(serviceDeliverableEvidence)
  .where(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId));
const runsOf = (reportId: string) => getTestDb().select().from(reportRuns).where(eq(reportRuns.reportId, reportId));
const managedDefinitionsOf = (orgId: string) => getTestDb().select().from(reports)
  .where(and(eq(reports.orgId, orgId), eq(reports.type, TYPE), eq(reports.portalSelfService, true)));

async function seedDeliverable(orgId: string, techId: string, reportId: string): Promise<string> {
  const [row] = await getTestDb().insert(serviceDeliverables).values({
    orgId, name: `Endpoint management review ${randomUUID().slice(0, 8)}`, cadence: 'monthly',
    anchorDueDate: DUE, effectiveFrom: '2026-10-01',
    leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve',
    ownerUserId: techId, autoEvidenceReportId: reportId,
  }).returning({ id: serviceDeliverables.id });
  return row!.id;
}

describe('endpoint management evidence on real Postgres (#5784 W03)', () => {
  runDb('1. a partner-wide template produces the artifact end to end — never wired by hand', async () => {
    const t = await seedTenant();
    const actor = actorFor(t);
    await seedSyncState(t);
    await seedSkuState(t);
    const device = await createDevice({ orgId: t.orgId, siteId: t.siteAId });
    await seedIntuneDevice(t.orgId, { breezeDeviceId: device.id });
    await getTestDb().insert(m365PostureRollups).values({
      orgId: t.orgId, tenantId: t.m365TenantId, rollupDate: '2026-10-29',
      devicesTotal: 1, devicesCompliant: 1, devicesNoncompliant: 0, devicesInGrace: 0, devicesUnknown: 0,
    });
    await getTestDb().insert(m365LicenseSkus).values({
      orgId: t.orgId, graphId: randomUUID(), coreHash: 'b'.repeat(64),
      skuPartNumber: 'SPE_E3', consumedUnits: 4, prepaidEnabled: 5, capabilityStatus: 'Enabled',
    });

    const set = await system(() => createTemplateSet({
      ownerScope: 'partner', name: `Best plan ${randomUUID().slice(0, 8)}`,
      items: [{
        name: 'Endpoint management review', cadence: 'monthly', leadDays: 7, graceDays: 14,
        artifactRequired: true, completionMode: 'on_ticket_resolve', sortOrder: 0,
        autoEvidenceReportType: TYPE,
      }],
    }, actor));
    expect(set.items[0]!.autoEvidenceReportType).toBe(TYPE);

    const applied = await system(() => applyTemplateSet(t.orgId, set.id, { effectiveFrom: '2026-10-01' }, actor));
    expect(applied.created).toHaveLength(1);
    const [managed] = await managedDefinitionsOf(t.orgId);
    expect(managed).toBeTruthy();
    // Provisioned from the closed registry's default config, not from a route body.
    expect(managed!.config).toMatchObject({ staleEnrolmentDays: 14, trendDays: 30, includeLicences: true });

    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ failed: 0 });

    const runs = await runsOf(managed!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed', requestedByKind: 'system', requestedByUserId: null,
      executionScopePrincipalKind: 'system', executionScopeKind: 'unrestricted',
    });
    const summary = (runs[0]!.result as { summary?: EndpointManagementSummary }).summary!;
    expect(summary.enrolment?.intuneDevices).toBe(1);
    expect(summary.compliance?.byState).toMatchObject({ compliant: 1 });
    expect(summary.compliance?.trend?.[0]).toMatchObject({ date: '2026-10-29', compliant: 1 });
    expect(summary.licences?.[0]).toMatchObject({ skuPartNumber: 'SPE_E3', consumedUnits: 4 });
    expect(summary.historyCaveat).toBeTruthy();

    const [occ] = await occurrencesOf(applied.created[0]!.id);
    const ev = await evidenceOf(occ!.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'report_run', reportId: managed!.id, reportRunId: runs[0]!.id });
  });

  runDb('2. a PARTIAL snapshot is not treated as fresh — asOf is last_complete_snapshot_at', async () => {
    const t = await seedTenant();
    // last_success_at is NOW; the last COMPLETE snapshot is 29 days old. A
    // partial run succeeds without enumerating the tenant.
    await seedSyncState(t, {
      lastStatus: 'partial',
      lastSuccessAt: AS_OF,
      lastCompleteSnapshotAt: new Date('2026-10-02T05:18:00Z'),
    });
    await seedSkuState(t);
    const device = await createDevice({ orgId: t.orgId, siteId: t.siteAId });
    await seedIntuneDevice(t.orgId, { breezeDeviceId: device.id });

    const result = await system(() => generateEndpointManagementReport(
      t.orgId, {}, authority(t.orgId, t.techId),
      { periodStart: '2026-10-01', periodEnd: DUE, generatedAt: AS_OF.toISOString(), deliverableId: randomUUID() },
    ));
    const s = result.summary as EndpointManagementSummary;
    // If this reads back the SUCCESS timestamp the generator is on the wrong
    // column — stop, do not relax the assertion.
    expect(s.freshness?.intune_devices?.asOf).toBe('2026-10-02T05:18:00.000Z');
    expect(s.freshness?.intune_devices?.stale).toBe(true);
    expect(s.freshness?.intune_devices?.note).toMatch(/stale/i);
    // 29 days is stale against a 6 h cadence even though it sits inside the
    // October reporting period.
    expect(s.dataGaps?.join(' ')).toMatch(/stale/i);
  });

  runDb('3. no sync state produces a data-gap artifact, not zeros', async () => {
    const t = await seedTenant();
    // Breeze devices exist; the Intune domain has never run.
    await createDevice({ orgId: t.orgId, siteId: t.siteAId });

    const result = await system(() => generateEndpointManagementReport(
      t.orgId, {}, authority(t.orgId, t.techId),
    ));
    const s = result.summary as EndpointManagementSummary;
    // If this reads 0 the report is claiming an empty tenant it never enumerated.
    expect(s.enrolment?.intuneDevices).toBeNull();
    expect(s.enrolment?.intuneWithoutBreezeLink).toBeNull();
    expect(s.compliance?.byState).toBeNull();
    expect(s.staleEnrolments?.count).toBeNull();
    expect(s.dataGaps?.length).toBeGreaterThan(0);
    // Our own side is still measured — that number is honest.
    expect(s.enrolment?.breezeDevices).toBe(1);
    expect(s.historyCaveat).toBeTruthy();
  });

  runDb('4. the unlinked Intune population is counted, never enumerated, under a restricted authority', async () => {
    const t = await seedTenant();
    await seedSyncState(t);
    await seedSkuState(t);
    const inScope = await createDevice({ orgId: t.orgId, siteId: t.siteAId });
    const outOfScope = await createDevice({ orgId: t.orgId, siteId: t.siteBId });
    const linkedInScope = await seedIntuneDevice(t.orgId, { breezeDeviceId: inScope.id, deviceName: 'IN-SCOPE' });
    await seedIntuneDevice(t.orgId, { breezeDeviceId: outOfScope.id, deviceName: 'OUT-OF-SCOPE' });
    await seedIntuneDevice(t.orgId, { breezeDeviceId: null, deviceName: 'UNLINKED' });

    const result = await system(() => generateEndpointManagementReport(
      t.orgId, {}, authority(t.orgId, t.techId, [t.siteAId]),
    ));
    const s = result.summary as EndpointManagementSummary;
    const rows = result.rows as IntuneDeviceRow[];

    expect(s.enrolment?.intuneWithoutBreezeLink).toBe(1);
    // The reported total counts only what this authority can account for: the
    // one in-scope linked device plus the one unlinked record. NOT 3 — the
    // out-of-site linked device is neither listed nor counted, so the artifact
    // never discloses the tenant's full enrolment scale to a restricted reader.
    expect(s.enrolment?.intuneDevices).toBe(2);
    // The load-bearing assertion: only the linked, in-site device is listed.
    expect(rows.map((r) => r.id)).toEqual([linkedInScope]);
    expect(rows.every((r) => r.breezeDeviceId)).toBe(true);
    expect(rows.map((r) => r.deviceName)).not.toContain('UNLINKED');
    expect(rows.map((r) => r.deviceName)).not.toContain('OUT-OF-SCOPE');
  });

  runDb('5. OD-12: invisible until delivered, and the server PDF path reaches the endpoint-management arm', async () => {
    const t = await seedTenant();
    await getTestDb().insert(portalBranding).values({ orgId: t.orgId, enableReports: true, enableService: true });
    await seedSyncState(t);
    await seedSkuState(t);
    const device = await createDevice({ orgId: t.orgId, siteId: t.siteAId });
    await seedIntuneDevice(t.orgId, { breezeDeviceId: device.id, complianceState: 'noncompliant' });

    const managed = await system(() => resolveManagedEvidenceDefinition(t.orgId, TYPE, t.techId));
    const deliverableId = await seedDeliverable(t.orgId, t.techId, managed.id);
    await runDeliverableSweep(AS_OF);

    const [occ] = await occurrencesOf(deliverableId);
    const [run] = await runsOf(managed.id);
    expect(run!.status).toBe('completed');

    const before = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(before.data.map((r) => r.id)).not.toContain(run!.id);
    // Specifically the OD-12 gate, not any exception: a bare `.toThrow()` would
    // also pass on an unrelated failure earlier in the call chain and prove
    // nothing about visibility.
    await expect(system(() => renderRunPdf(run!.id, t.orgId, 'UTC')))
      .rejects.toBeInstanceOf(PortalReportNotFoundError);

    await system(() => deliverOccurrence(t.orgId, occ!.id, { note: 'Reviewed' },
      { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: [t.orgId] }));

    const after = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    const listed = after.data.find((r) => r.id === run!.id);
    expect(listed).toBeTruthy();
    // PortalRunDto's union had to be widened for this: portalRunListPredicate
    // has no type filter, so an unwidened union was a type lie the compiler
    // could not see because the value comes from the database.
    expect(listed!.type).toBe(TYPE);

    const pdf = await system(() => renderRunPdf(run!.id, t.orgId, 'UTC'));
    expect(Buffer.isBuffer(pdf) && pdf.length > 0).toBe(true);
    // The proof the arm is hit rather than renderGenericReport: the generic
    // renderer prints `rows` as a plain table and draws NONE of these section
    // headings, so their presence means the designed summary was rendered.
    // Matched as short, unwrapped strings — jsPDF splits a long paragraph
    // across several Tj operators, so a whole sentence is not greppable.
    const text = pdf.toString('latin1');
    expect(text).toMatch(/Endpoint Management Review/);
    expect(text).toMatch(/Enrolment coverage/);
    // The history caveat's own section, always drawn (see HISTORY_CAVEAT).
    expect(text).toMatch(/About this report/);
  });
});
