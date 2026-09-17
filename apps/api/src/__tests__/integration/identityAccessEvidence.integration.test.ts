/**
 * Identity & Access Review evidence, end to end on real Postgres (#5784 W06,
 * #5812 / #5818).
 *
 * The four things that are specific to this report type and cannot be
 * established by any unit test:
 *
 *  1. a partner-wide template applied to an org produces the artifact against
 *     that org's own managed definition, over real `m365_signin_events` rows,
 *     with nothing wired by hand;
 *  2. a RESTRICTED authority gets NOTHING — not a site-filtered subset (OD-8 =
 *     A). M365 identity data has no site dimension, so serving it to a
 *     site-limited technician would be a scope escalation. If an identity row
 *     comes back, stop;
 *  3. the unlicensed tenant and the `hidden` risk sentinel render as DATA GAPS,
 *     never as zeros — if the unlicensed case ever reads 0, the feature is
 *     shipping a lie and must not merge;
 *  4. OD-12: the run is invisible until delivery — and this artifact carries
 *     user principal names and IP addresses, so the gate is doing real work
 *     here — and the server-side `renderRunPdf` path reaches the new
 *     `buildReportPdf` arm (the rendered bytes contain the coverage section and
 *     the words "interactive sign-ins") rather than falling silently through to
 *     `renderGenericReport`, which would keep the sign-in rows while dropping
 *     every caveat printed beside them.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  devices, m365CaPolicies, m365Connections, m365SigninEvents, m365SyncState, m365Users,
  portalBranding, reportRuns, reports, serviceDeliverableEvidence,
  serviceDeliverableOccurrences, serviceDeliverables,
} from '../../db/schema';
import {
  assignUserToPartner, createOrganization, createPartner, createRole, createSite, createUser,
  grantRolePermissions,
} from './db-utils';
import { runDeliverableSweep } from '../../jobs/deliverableWorker';
import { applyTemplateSet, createTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';
import { deliverOccurrence } from '../../services/serviceDeliverableService';
import { listPortalRuns, renderRunPdf } from '../../services/portal/reportsSelfService';
import { generateIdentityAccessReport } from '../../services/identityAccessReport';
import { siteScopeFingerprint } from '../../services/siteScope';
import type { IdentityAccessSummary } from '@breeze/shared';

// publishEvent writes to a Redis stream — spy on it (deliverableSweep precedent).
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: vi.fn(async () => 'test-event-id') };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MANAGED_TYPE = 'identity_access_review' as const;
const AS_OF = new Date('2026-10-31T05:18:00Z');
const PERIOD_START = '2026-10-01';
const PERIOD_END = '2026-10-31';
const ADMIN_UPN = 'root@contoso.test';
const ADMIN_IP = '203.0.113.9';
const credentialVersion = '0123456789abcdef0123456789abcdef';

const system = <T>(fn: () => Promise<T>, label = 'identityAccessEvidence.integration') =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

// The whole wave is inert unless the sync flag is on (config/env.ts, read at
// CALL time), so the suite turns it on for its own duration and restores it.
let previousFlag: string | undefined;
beforeAll(() => {
  previousFlag = process.env.M365_TENANT_SYNC_ENABLED;
  process.env.M365_TENANT_SYNC_ENABLED = 'true';
});
afterAll(() => {
  if (previousFlag === undefined) delete process.env.M365_TENANT_SYNC_ENABLED;
  else process.env.M365_TENANT_SYNC_ENABLED = previousFlag;
});

interface Tenant { partnerId: string; orgId: string; techId: string; tenantId: string; connectionId: string }

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' },
    { resource: 'contracts', action: 'read' }, { resource: 'contracts', action: 'write' },
  ]);
  const tech = (await createUser({
    partnerId: partner.id, orgId: null, email: `tech-${randomUUID()}@example.com`, name: 'Tess Tech',
  }))!;
  await assignUserToPartner(tech.id, partner.id, role.id, 'all');

  const tenantId = randomUUID();
  const [connection] = await getTestDb().insert(m365Connections).values({
    orgId: org.id, userId: null, tenantId,
    consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
    profile: 'customer-graph-read', authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${tenantId}/${credentialVersion}`,
    credentialVersion, permissionManifestVersion: 3, status: 'active',
  }).returning({ id: m365Connections.id });

  return { partnerId: partner.id, orgId: org.id, techId: tech.id, tenantId, connectionId: connection!.id };
}

const actorFor = (t: Tenant): TemplateActor => ({
  userId: t.techId, scope: 'partner', partnerId: t.partnerId, partnerOrgAccess: 'all',
  accessibleOrgIds: [t.orgId],
});

/** A COMPLETE snapshot for the signin_events domain — `last_complete_snapshot_at`
 *  is the freshness the artifact prints, never `last_success_at`. */
async function seedSyncState(t: Tenant, over: Partial<typeof m365SyncState.$inferInsert> = {}) {
  await getTestDb().insert(m365SyncState).values({
    orgId: t.orgId, connectionId: t.connectionId, domain: 'signin_events',
    intervalSeconds: 3600,
    lastRunAt: new Date('2026-10-31T04:00:00Z'),
    // Deliberately LATER than the complete snapshot: a partial run advances
    // this, and the artifact must not quote it as its freshness.
    lastSuccessAt: new Date('2026-10-31T04:30:00Z'),
    lastCompleteSnapshotAt: new Date('2026-10-31T04:00:00Z'),
    lastStatus: 'success',
    sources: { signinEvents: 'ok' },
    ...over,
  });
}

async function seedSignin(t: Tenant, over: Partial<typeof m365SigninEvents.$inferInsert> = {}) {
  await getTestDb().insert(m365SigninEvents).values({
    orgId: t.orgId, tenantId: t.tenantId, graphId: `sg-${randomUUID()}`,
    signedInAt: new Date('2026-10-12T09:00:00Z'),
    userGraphId: randomUUID(), userPrincipalName: 'ada@contoso.test',
    appId: 'app-1', appDisplayName: 'Outlook', clientAppUsed: 'Browser',
    ipAddress: '203.0.113.7', locationCity: 'Austin', locationCountry: 'US',
    conditionalAccessStatus: 'success', statusErrorCode: 0, statusFailureReason: null,
    riskLevelAggregated: 'none', riskState: 'none', isInteractive: true,
    ...over,
  });
}

async function seedUser(t: Tenant, over: Partial<typeof m365Users.$inferInsert> = {}) {
  await getTestDb().insert(m365Users).values({
    orgId: t.orgId, graphId: `u-${randomUUID()}`, coreHash: 'a'.repeat(64),
    userPrincipalName: 'ada@contoso.test', displayName: 'Ada L',
    accountEnabled: true, isAdmin: false, mfaRegistered: true,
    lastSuccessfulSignInAt: new Date('2026-10-12T09:00:00Z'),
    ...over,
  });
}

async function seedCaPolicy(t: Tenant, over: Partial<typeof m365CaPolicies.$inferInsert> = {}) {
  await getTestDb().insert(m365CaPolicies).values({
    orgId: t.orgId, graphId: `ca-${randomUUID()}`, coreHash: 'b'.repeat(64),
    definitionHash: 'c'.repeat(64),
    displayName: 'MFA for admins', state: 'enabled',
    lastChangedAt: new Date('2026-10-15T00:00:00Z'), isStale: false,
    ...over,
  });
}

async function seedDevice(t: Tenant, hostname: string): Promise<{ id: string; siteId: string }> {
  const site = await createSite({ orgId: t.orgId });
  const [row] = await getTestDb().insert(devices).values({
    orgId: t.orgId, siteId: site!.id, agentId: `ia-${randomUUID()}`, hostname,
    osType: 'windows', osVersion: 'Windows 11 Pro', architecture: 'amd64',
    agentVersion: '0.113.0', status: 'online',
    activeVpns: [{
      provider: 'tailscale', active: true, interfaceName: 'utun3',
      detectionSource: 'interface', reportedAt: '2026-10-31T04:00:00.000Z',
    }],
  }).returning({ id: devices.id });
  return { id: row!.id, siteId: site!.id };
}

const occurrencesOf = (deliverableId: string) => getTestDb().select().from(serviceDeliverableOccurrences)
  .where(eq(serviceDeliverableOccurrences.deliverableId, deliverableId)).orderBy(serviceDeliverableOccurrences.dueAt);
const evidenceOf = (occurrenceId: string) => getTestDb().select().from(serviceDeliverableEvidence)
  .where(eq(serviceDeliverableEvidence.occurrenceId, occurrenceId));
const runsOf = (reportId: string) => getTestDb().select().from(reportRuns).where(eq(reportRuns.reportId, reportId));
const managedDefinitionsOf = (orgId: string) => getTestDb().select().from(reports)
  .where(and(eq(reports.orgId, orgId), eq(reports.type, MANAGED_TYPE), eq(reports.portalSelfService, true)));

async function applyMonthlyTemplate(t: Tenant): Promise<void> {
  const actor = actorFor(t);
  const set = await system(() => createTemplateSet({
    ownerScope: 'partner', name: `Managed identity plan ${randomUUID().slice(0, 8)}`,
    items: [{
      name: 'Monthly identity and access review', cadence: 'monthly', leadDays: 7, graceDays: 14,
      artifactRequired: true, completionMode: 'explicit', sortOrder: 0,
      autoEvidenceReportType: MANAGED_TYPE,
    }],
  }, actor));
  expect(set.items[0]!.autoEvidenceReportType).toBe(MANAGED_TYPE);
  const applied = await system(() => applyTemplateSet(t.orgId, set.id, { effectiveFrom: '2026-10-01' }, actor));
  expect(applied.created).toHaveLength(1);
}

function summaryOfRun(row: { result: unknown }): IdentityAccessSummary {
  return (row.result as { summary: IdentityAccessSummary }).summary;
}

const evidenceContext = () => ({
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
  generatedAt: '2026-10-31T05:18:00.000Z',
  deliverableId: randomUUID(),
});

function unrestrictedAuthority(t: Tenant) {
  const scope = { version: 1 as const, kind: 'unrestricted' as const, orgId: t.orgId };
  return {
    principalKind: 'user' as const,
    principalUserId: t.techId,
    scope,
    capturedAt: AS_OF,
    fingerprint: siteScopeFingerprint(scope),
  };
}

describe('identity and access review evidence on real Postgres (#5784 W06)', () => {
  runDb('1. a partner-wide template produces the artifact over real sign-in events', async () => {
    const t = await seedTenant();
    await seedSyncState(t);
    await seedDevice(t, 'host-1');
    await seedUser(t, { userPrincipalName: ADMIN_UPN, displayName: 'Root Admin', isAdmin: true, mfaRegistered: true });
    await seedUser(t);
    // An enabled account nobody has been seen signing in with: dormant, and
    // "never observed" rather than "a long time ago".
    await seedUser(t, { userPrincipalName: 'stale@contoso.test', lastSuccessfulSignInAt: null });
    await seedSignin(t);
    await seedSignin(t, { userPrincipalName: ADMIN_UPN, ipAddress: ADMIN_IP, appDisplayName: 'Azure Portal' });
    // Outside the period — proves the window is bound, not ignored.
    await seedSignin(t, { signedInAt: new Date('2026-09-02T09:00:00Z') });
    await seedCaPolicy(t);
    await seedCaPolicy(t, {
      displayName: 'Old rule', state: 'disabled',
      lastChangedAt: new Date('2026-01-01T00:00:00Z'), isStale: true,
    });

    await applyMonthlyTemplate(t);
    const res = await runDeliverableSweep(AS_OF);
    expect(res).toMatchObject({ autoEvidence: 1, failed: 0 });

    const [managed] = await managedDefinitionsOf(t.orgId);
    expect(managed!.name).toBe('Service evidence — Identity and access review');
    const runs = await runsOf(managed!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: 'completed', requestedByKind: 'system', requestedByUserId: null,
      executionScopePrincipalKind: 'system', executionScopeKind: 'unrestricted',
    });

    const s = summaryOfRun(runs[0]!);
    // Only the in-period sign-ins are counted.
    expect(s.signins?.total).toBe(2);
    expect(s.identity?.usersTotal).toBe(3);
    expect(s.identity?.admins).toBe(1);
    // Freshness is last_complete_snapshot_at (04:00), NOT last_success_at (04:30).
    expect(s.coverage?.asOf).toBe('2026-10-31T04:00:00.000Z');
    // The window it ACTUALLY covers starts before the period, because the
    // September event is held too — so there is no shortfall to print.
    expect(s.coverage?.coveredFrom?.slice(0, 10)).toBe('2026-09-02');
    expect(s.coverage?.periodStart).toBe(PERIOD_START);
    // Admin detail is the admin's sign-in only.
    expect(s.adminSignins?.map((r) => r.userPrincipalName)).toEqual([ADMIN_UPN]);
    // Dormant: the never-observed account, with a NULL last sign-in preserved.
    const dormant = s.dormant?.rows.find((r) => r.userPrincipalName === 'stale@contoso.test');
    expect(dormant?.lastSuccessfulSignInAt).toBeNull();
    // CA posture: one policy changed in-period, one stale.
    expect(s.conditionalAccess?.changedThisPeriod).toBe(1);
    expect(s.conditionalAccess?.policies?.find((p) => p.displayName === 'Old rule')?.isStale).toBe(true);
    // Remote access is CLIENT PRESENCE, and says so.
    expect(s.remoteAccess?.byProvider).toEqual({ tailscale: 1 });
    expect(s.remoteAccess?.caveat).toMatch(/client presence/i);
    expect(s.remoteAccess?.caveat).not.toMatch(/VPN policy review/i);

    const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, t.orgId));
    const [occ] = await occurrencesOf(d!.id);
    const ev = await evidenceOf(occ!.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'report_run', reportId: managed!.id, reportRunId: runs[0]!.id });
  });

  runDb('2. a RESTRICTED technician gets nothing, and no identity row comes back', async () => {
    const t = await seedTenant();
    await seedSyncState(t);
    const device = await seedDevice(t, 'host-2');
    await seedUser(t, { userPrincipalName: ADMIN_UPN, isAdmin: true });
    await seedSignin(t, { userPrincipalName: ADMIN_UPN, ipAddress: ADMIN_IP });
    await seedCaPolicy(t);

    const scope = { version: 1 as const, kind: 'restricted' as const, orgId: t.orgId, siteIds: [device.siteId] };
    const authority = {
      principalKind: 'user' as const,
      principalUserId: t.techId,
      scope,
      capturedAt: AS_OF,
      fingerprint: siteScopeFingerprint(scope),
    };

    const res = await system(() => generateIdentityAccessReport(t.orgId, {}, authority, evidenceContext()));
    const s = res.summary as unknown as IdentityAccessSummary;

    // THE scope-escalation guard. If identity rows come back, stop.
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(s.identity?.usersTotal).toBeNull();
    expect(s.signins?.total).toBeNull();
    expect(s.adminSignins ?? null).toBeNull();
    expect(s.dormant ?? null).toBeNull();
    expect(JSON.stringify(s)).not.toContain(ADMIN_UPN);
    expect(JSON.stringify(s)).not.toContain(ADMIN_IP);
    // And the reason given is the READER'S SCOPE, not a data problem.
    expect(s.dataGaps?.join(' ')).toMatch(/org-wide/i);
  });

  runDb('3. an unlicensed tenant produces a data-gap artifact, NOT zeros', async () => {
    const t = await seedTenant();
    // W05 persists `unlicensed` as a COMPLETE, zero-update success: the
    // permission was granted, the Entra ID P1/P2 licence was not.
    await seedSyncState(t, { sources: { signinEvents: 'unlicensed' } });
    await seedUser(t);
    await seedCaPolicy(t);

    const res = await system(() => generateIdentityAccessReport(
      t.orgId, {}, unrestrictedAuthority(t), evidenceContext(),
    ));
    const s = res.summary as unknown as IdentityAccessSummary;

    // THE assertion that stops this feature shipping a lie. If it reads 0, stop.
    expect(s.coverage?.unlicensed).toBe(true);
    expect(s.signins?.total).toBeNull();
    expect(s.signins?.failures).toBeNull();
    expect(s.dataGaps?.length).toBeGreaterThan(0);
    expect(s.dataGaps!.join(' ')).toMatch(/licen[cs]e/i);
    expect(s.dataGaps!.join(' ')).not.toMatch(/\bno sign-ins\b/i);
    // The identity and CA halves come from other domains and still render.
    expect(s.identity?.usersTotal).toBe(1);
    expect(s.conditionalAccess?.policies).toHaveLength(1);
  });

  runDb('4. the coverage window is honest about a mid-period start', async () => {
    const t = await seedTenant();
    await seedSyncState(t);
    await seedUser(t);
    // Collection began on the 20th — the case every first monthly report after
    // enabling W05 will hit.
    await seedSignin(t, { signedInAt: new Date('2026-10-20T09:00:00Z') });
    await seedSignin(t, { signedInAt: new Date('2026-10-25T09:00:00Z') });

    const res = await system(() => generateIdentityAccessReport(
      t.orgId, {}, unrestrictedAuthority(t), evidenceContext(),
    ));
    const s = res.summary as unknown as IdentityAccessSummary;

    expect(s.coverage?.coveredFrom?.slice(0, 10)).toBe('2026-10-20');
    expect(s.coverage?.note).toMatch(/does not cover/i);
    expect(s.dataGaps!.join(' ')).toMatch(/2026-10-20/);
  });

  runDb('5. mfa NULL is unknown, not "without" — and hidden risk is unmeasured', async () => {
    const t = await seedTenant();
    await seedSyncState(t);
    await seedUser(t, { userPrincipalName: 'a1@contoso.test', isAdmin: true, mfaRegistered: null });
    await seedUser(t, { userPrincipalName: 'a2@contoso.test', isAdmin: true, mfaRegistered: false });
    // Graph's `hidden` sentinel: the tenant has no Entra ID P2.
    await seedSignin(t, { riskLevelAggregated: 'hidden', riskState: 'hidden' });
    await seedSignin(t, { riskLevelAggregated: 'hidden', riskState: 'hidden' });

    const res = await system(() => generateIdentityAccessReport(
      t.orgId, {}, unrestrictedAuthority(t), evidenceContext(),
    ));
    const s = res.summary as unknown as IdentityAccessSummary;

    expect(s.identity?.adminsWithoutMfa).toBe(1);
    expect(s.identity?.adminsMfaUnknown).toBe(1);
    expect(s.identity?.mfaUnknown).toBe(1);
    // Unmeasured, never "no risk detected".
    expect(s.signins?.byRiskLevel).toBeNull();
    expect(s.dataGaps!.join(' ')).toMatch(/P2|risk/i);
  });

  runDb('6. OD-12: invisible until delivered, then rendered through the identity PDF arm', async () => {
    const t = await seedTenant();
    await getTestDb().insert(portalBranding).values({ orgId: t.orgId, enableReports: true, enableService: true });
    await seedSyncState(t);
    await seedDevice(t, 'host-6');
    await seedUser(t, { userPrincipalName: ADMIN_UPN, isAdmin: true });
    await seedSignin(t, { userPrincipalName: ADMIN_UPN, ipAddress: ADMIN_IP });
    await seedCaPolicy(t);

    await applyMonthlyTemplate(t);
    await runDeliverableSweep(AS_OF);

    const [managed] = await managedDefinitionsOf(t.orgId);
    const [run] = await runsOf(managed!.id);
    const [d] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.orgId, t.orgId));
    const [occ] = await occurrencesOf(d!.id);
    expect(run!.status).toBe('completed');

    // Completed and portal_self_service — and still not the customer's to see.
    // This artifact carries user principal names and IP addresses, so the
    // delivery gate is doing real work here, not bookkeeping.
    const before = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(before.data.map((r) => r.id)).not.toContain(run!.id);
    await expect(system(() => renderRunPdf(run!.id, t.orgId, 'UTC'))).rejects.toThrow();

    await system(() => deliverOccurrence(t.orgId, occ!.id, { note: 'Reviewed' },
      { userId: t.techId, partnerId: t.partnerId, accessibleOrgIds: [t.orgId] }));

    const after = await system(() => listPortalRuns(t.orgId, 'UTC', { page: 1, limit: 50 }));
    expect(after.data.map((r) => r.id)).toContain(run!.id);
    expect(after.data.find((r) => r.id === run!.id)?.type).toBe(MANAGED_TYPE);

    const pdf = await system(() => renderRunPdf(run!.id, t.orgId, 'UTC'));
    expect(Buffer.isBuffer(pdf) && pdf.length > 0).toBe(true);
    // The proof that the SERVER-SIDE path reached the new buildReportPdf arm
    // rather than falling silently through to renderGenericReport, which would
    // print the sign-in rows as a plain table and drop every caveat beside them.
    const text = pdf.toString('latin1');
    expect(text).toContain('Identity & Access Review');
    expect(text).toContain('What this covers');
    expect(text.toLowerCase()).toContain('interactive sign-ins');
  });
});
