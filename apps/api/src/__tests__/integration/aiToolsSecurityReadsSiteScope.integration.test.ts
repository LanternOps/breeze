/**
 * Integration test — security/compliance read tool site-scope parity against
 * real Postgres.
 *
 * Mirrors `aiToolsAuditDetailsSiteScope.integration.test.ts`: registers each
 * tool family into a local `Map`, seeds real rows as the superuser test
 * client (`getTestDb()`), then drives the handler through `withDbAccessContext`
 * so org-axis RLS is genuinely enforced by `breeze_app` while the site axis
 * (app-layer only) is exercised on top. Per tool this proves:
 *   (i)   a site-restricted caller gets no row / not-found for an out-of-site
 *         object;
 *   (ii)  the same caller DOES see the in-site object (non-vacuous control);
 *   (iii) a cross-org id is not found;
 *   (iv)  an unrestricted (all-sites) caller sees both.
 *
 * Also covers end-to-end:
 *   - get_browser_security and get_sensitive_data_overview fail closed (empty
 *     result, no query) when a site-restricted caller's org never resolves;
 *   - get_compliance_status rejects a policyId belonging to an org the caller
 *     cannot access ("Policy not found"), mirroring getPolicyWithOrgCheck.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { withDbAccessContext } from '../../db';
import {
  devices,
  browserExtensions,
  softwarePolicies,
  softwareComplianceStatus,
  automationPolicies,
  automationPolicyCompliance,
  elevationRequests,
  peripheralEvents,
  sensitiveDataScans,
  sensitiveDataFindings,
  userRiskScores,
  organizationUsers,
  users,
} from '../../db/schema';
import { createPartner, createOrganization, createSite, createRole, createUser } from './db-utils';
import { getTestDb } from './setup';
import { registerBrowserTools } from '../../services/aiToolsBrowser';
import { registerComplianceTools } from '../../services/aiToolsCompliance';
import { registerPamTools } from '../../services/aiToolsPam';
import { registerPeripheralTools } from '../../services/aiToolsPeripherals';
import { registerSecurityTools } from '../../services/aiToolsSecurity';
import { registerUserRiskTools } from '../../services/aiToolsUserRisk';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

function handlerFor(
  register: (map: Map<string, AiTool>) => void,
  name: string,
): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  register(reg);
  const tool = reg.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.handler;
}

// Build an org-scope AuthContext. `allowedSiteIds` (+ canAccessSite) makes the
// caller site-restricted; omit them for an unrestricted caller. `orgId: null`
// (with allowedSiteIds set) exercises the null-org fail-closed path.
function makeAuth(orgId: string | null, allowedSiteIds?: string[]): AuthContext {
  return {
    user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: orgId ? [orgId] : [],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => (orgId ? id === orgId : false),
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

async function withOrgContext<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(
    { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
    fn,
  );
}

// For the null-org fail-closed cases: auth.orgId is null and no org
// can be resolved, so there is nothing tenant-scoped to open a context for.
// The handler must return its empty shape before ever touching `db`; a
// system-scope context is only here so the call goes through
// `withDbAccessContext` like every other request-path DB access, per
// CLAUDE.md (bare pool access is forbidden in request code).
async function withNoOrgContext<T>(fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext({ scope: 'system', orgId: null, accessibleOrgIds: null }, fn);
}

async function seedDevice(orgId: string, siteId: string) {
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning();
  return d!;
}

describe('security/compliance AI read tools — site scope + cross-org', () => {
  // ------------------------------------------------------------------
  // get_browser_security
  // ------------------------------------------------------------------
  describe('get_browser_security', () => {
    it('site-restricted caller: hides out-of-site, shows in-site, denies cross-org, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
      const outScopeDevice = await seedDevice(org.id, siteForbidden.id);
      const otherOrgSite = await createSite({ orgId: otherOrg.id });
      const otherOrgDevice = await seedDevice(otherOrg.id, otherOrgSite.id);

      const now = new Date();
      await getTestDb().insert(browserExtensions).values([
        {
          orgId: org.id,
          deviceId: inScopeDevice.id,
          browser: 'chrome',
          extensionId: 'ext-in-scope',
          name: 'In Scope Extension',
          source: 'store',
          permissions: [],
          riskLevel: 'low',
          firstSeenAt: now,
          lastSeenAt: now,
        },
        {
          orgId: org.id,
          deviceId: outScopeDevice.id,
          browser: 'chrome',
          extensionId: 'ext-out-scope',
          name: 'Out Of Scope Extension',
          source: 'store',
          permissions: [],
          riskLevel: 'low',
          firstSeenAt: now,
          lastSeenAt: now,
        },
        {
          orgId: otherOrg.id,
          deviceId: otherOrgDevice.id,
          browser: 'chrome',
          extensionId: 'ext-other-org',
          name: 'Other Org Extension',
          source: 'store',
          permissions: [],
          riskLevel: 'low',
          firstSeenAt: now,
          lastSeenAt: now,
        },
      ]);

      const handler = handlerFor(registerBrowserTools, 'get_browser_security');

      // (i) + (ii): site-restricted caller
      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () => handler({}, restrictedAuth));
      const restricted = JSON.parse(restrictedRaw);
      const restrictedNames = restricted.extensions.map((e: any) => e.name ?? e.extensionId);
      expect(restrictedNames).toContain('In Scope Extension');
      expect(restrictedNames).not.toContain('Out Of Scope Extension');
      expect(JSON.stringify(restricted)).not.toContain(outScopeDevice.id);

      // (iii) cross-org: querying with orgId of the other org is denied by canAccessOrg
      const crossOrgRaw = await withOrgContext(org.id, () =>
        handler({ orgId: otherOrg.id }, restrictedAuth),
      );
      const crossOrg = JSON.parse(crossOrgRaw);
      expect(crossOrg.error).toBeDefined();

      // (iv) unrestricted caller sees both in-org extensions
      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () => handler({}, unrestrictedAuth));
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedNames = unrestricted.extensions.map((e: any) => e.name ?? e.extensionId);
      expect(unrestrictedNames).toContain('In Scope Extension');
      expect(unrestrictedNames).toContain('Out Of Scope Extension');
    });

    it('fails closed with empty results when a site-restricted caller has no resolvable org', async () => {
      const handler = handlerFor(registerBrowserTools, 'get_browser_security');
      // orgId null, no input.orgId — the site-restriction guard must return
      // an empty shape without ever issuing a query.
      const auth = makeAuth(null, [randomUUID()]);
      const raw = await withNoOrgContext(() => handler({}, auth));
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({
        summary: { total: 0, low: 0, medium: 0, high: 0, critical: 0, sideloaded: 0 },
        extensions: [],
        violations: [],
      });
    });
  });

  // ------------------------------------------------------------------
  // get_software_compliance
  // ------------------------------------------------------------------
  describe('get_software_compliance', () => {
    it('site-restricted caller: hides out-of-site, shows in-site, denies cross-org, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
      const outScopeDevice = await seedDevice(org.id, siteForbidden.id);
      const otherOrgSite = await createSite({ orgId: otherOrg.id });
      const otherOrgDevice = await seedDevice(otherOrg.id, otherOrgSite.id);

      const [policy] = await getTestDb()
        .insert(softwarePolicies)
        .values({
          orgId: org.id,
          name: 'In-org policy',
          mode: 'blocklist',
          rules: { software: [] },
        })
        .returning();
      const [otherPolicy] = await getTestDb()
        .insert(softwarePolicies)
        .values({
          orgId: otherOrg.id,
          name: 'Other org policy',
          mode: 'blocklist',
          rules: { software: [] },
        })
        .returning();

      const now = new Date();
      await getTestDb().insert(softwareComplianceStatus).values([
        { deviceId: inScopeDevice.id, policyId: policy!.id, status: 'violation', lastChecked: now },
        { deviceId: outScopeDevice.id, policyId: policy!.id, status: 'violation', lastChecked: now },
        { deviceId: otherOrgDevice.id, policyId: otherPolicy!.id, status: 'violation', lastChecked: now },
      ]);

      const handler = handlerFor(registerComplianceTools, 'get_software_compliance');

      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () => handler({}, restrictedAuth));
      const restricted = JSON.parse(restrictedRaw);
      const restrictedHosts = restricted.compliance.map((c: any) => c.device);
      expect(restrictedHosts).toContain(inScopeDevice.hostname);
      expect(restrictedHosts).not.toContain(outScopeDevice.hostname);

      // (iii) cross-org: org-scope caller never reaches the other org's rows —
      // the org axis (RLS + orgCondition) already excludes them.
      expect(restrictedHosts).not.toContain(otherOrgDevice.hostname);

      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () => handler({}, unrestrictedAuth));
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedHosts = unrestricted.compliance.map((c: any) => c.device);
      expect(unrestrictedHosts).toContain(inScopeDevice.hostname);
      expect(unrestrictedHosts).toContain(outScopeDevice.hostname);
    });
  });

  // ------------------------------------------------------------------
  // get_compliance_status
  // ------------------------------------------------------------------
  describe('get_compliance_status', () => {
    it('site-restricted caller: hides out-of-site, shows in-site, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
      const outScopeDevice = await seedDevice(org.id, siteForbidden.id);

      const [policy] = await getTestDb()
        .insert(automationPolicies)
        .values({
          orgId: org.id,
          name: 'Compliance policy',
          targets: {},
          rules: {},
        })
        .returning();

      const now = new Date();
      await getTestDb().insert(automationPolicyCompliance).values([
        { policyId: policy!.id, deviceId: inScopeDevice.id, status: 'compliant', lastCheckedAt: now },
        { policyId: policy!.id, deviceId: outScopeDevice.id, status: 'compliant', lastCheckedAt: now },
      ]);

      const handler = handlerFor(registerComplianceTools, 'get_compliance_status');

      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () =>
        handler({ policyId: policy!.id }, restrictedAuth),
      );
      const restricted = JSON.parse(restrictedRaw);
      const restrictedDeviceIds = restricted.records.map((r: any) => r.deviceId);
      expect(restrictedDeviceIds).toContain(inScopeDevice.id);
      expect(restrictedDeviceIds).not.toContain(outScopeDevice.id);

      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () =>
        handler({ policyId: policy!.id }, unrestrictedAuth),
      );
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedDeviceIds = unrestricted.records.map((r: any) => r.deviceId);
      expect(unrestrictedDeviceIds).toContain(inScopeDevice.id);
      expect(unrestrictedDeviceIds).toContain(outScopeDevice.id);
    });

    it('rejects a policyId belonging to an org the caller cannot access (policy-org check)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });

      const [otherOrgPolicy] = await getTestDb()
        .insert(automationPolicies)
        .values({
          orgId: otherOrg.id,
          name: 'Other org policy',
          targets: {},
          rules: {},
        })
        .returning();

      const handler = handlerFor(registerComplianceTools, 'get_compliance_status');
      const auth = makeAuth(org.id, undefined);
      const raw = await withOrgContext(org.id, () =>
        handler({ policyId: otherOrgPolicy!.id }, auth),
      );
      const parsed = JSON.parse(raw);
      expect(parsed.error).toBe('Policy not found');
    });
  });

  // ------------------------------------------------------------------
  // get_elevation_history
  // ------------------------------------------------------------------
  describe('get_elevation_history', () => {
    it('site-restricted caller: hides out-of-site, shows in-site, denies cross-org, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
      const outScopeDevice = await seedDevice(org.id, siteForbidden.id);
      const otherOrgSite = await createSite({ orgId: otherOrg.id });
      const otherOrgDevice = await seedDevice(otherOrg.id, otherOrgSite.id);

      // elevation_requests_flow_shape_chk requires subject_user_id NOT NULL for
      // flow_type = 'tech_jit_admin', and it FKs to users.id.
      const inScopeSubject = await createUser({ partnerId: partner.id, orgId: org.id });
      const outScopeSubject = await createUser({ partnerId: partner.id, orgId: org.id });
      const otherOrgSubject = await createUser({ partnerId: partner.id, orgId: otherOrg.id });

      const now = new Date();
      await getTestDb().insert(elevationRequests).values([
        {
          orgId: org.id,
          deviceId: inScopeDevice.id,
          flowType: 'tech_jit_admin',
          subjectUserId: inScopeSubject.id,
          subjectUsername: 'in-scope-user',
          reason: 'in-scope-request',
          status: 'approved',
          requestedAt: now,
          approvedAt: now,
        },
        {
          orgId: org.id,
          deviceId: outScopeDevice.id,
          flowType: 'tech_jit_admin',
          subjectUserId: outScopeSubject.id,
          subjectUsername: 'out-scope-user',
          reason: 'out-scope-request',
          status: 'approved',
          requestedAt: now,
          approvedAt: now,
        },
        {
          orgId: otherOrg.id,
          deviceId: otherOrgDevice.id,
          flowType: 'tech_jit_admin',
          subjectUserId: otherOrgSubject.id,
          subjectUsername: 'other-org-user',
          reason: 'other-org-request',
          status: 'approved',
          requestedAt: now,
          approvedAt: now,
        },
      ]);

      const handler = handlerFor(registerPamTools, 'get_elevation_history');

      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () => handler({}, restrictedAuth));
      const restricted = JSON.parse(restrictedRaw);
      const restrictedReasons = restricted.map((r: any) => r.reason);
      expect(restrictedReasons).toContain('in-scope-request');
      expect(restrictedReasons).not.toContain('out-scope-request');
      // (iii) cross-org: the org axis already excludes the other org's rows.
      expect(restrictedReasons).not.toContain('other-org-request');

      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () => handler({}, unrestrictedAuth));
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedReasons = unrestricted.map((r: any) => r.reason);
      expect(unrestrictedReasons).toContain('in-scope-request');
      expect(unrestrictedReasons).toContain('out-scope-request');
    });
  });

  // ------------------------------------------------------------------
  // get_peripheral_activity
  // ------------------------------------------------------------------
  describe('get_peripheral_activity', () => {
    it('site-restricted caller: hides out-of-site, shows in-site, denies cross-org, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
      const outScopeDevice = await seedDevice(org.id, siteForbidden.id);
      const otherOrgSite = await createSite({ orgId: otherOrg.id });
      const otherOrgDevice = await seedDevice(otherOrg.id, otherOrgSite.id);

      const now = new Date();
      await getTestDb().insert(peripheralEvents).values([
        {
          orgId: org.id,
          deviceId: inScopeDevice.id,
          eventType: 'connected',
          peripheralType: 'usb_storage',
          serialNumber: 'in-scope-serial',
          occurredAt: now,
        },
        {
          orgId: org.id,
          deviceId: outScopeDevice.id,
          eventType: 'connected',
          peripheralType: 'usb_storage',
          serialNumber: 'out-scope-serial',
          occurredAt: now,
        },
        {
          orgId: otherOrg.id,
          deviceId: otherOrgDevice.id,
          eventType: 'connected',
          peripheralType: 'usb_storage',
          serialNumber: 'other-org-serial',
          occurredAt: now,
        },
      ]);

      const handler = handlerFor(registerPeripheralTools, 'get_peripheral_activity');

      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () => handler({}, restrictedAuth));
      const restricted = JSON.parse(restrictedRaw);
      const restrictedSerials = restricted.events.map((e: any) => e.serialNumber);
      expect(restrictedSerials).toContain('in-scope-serial');
      expect(restrictedSerials).not.toContain('out-scope-serial');
      expect(restrictedSerials).not.toContain('other-org-serial');

      // (iii) cross-org: an explicit org_id for the other org is denied outright.
      const crossOrgRaw = await withOrgContext(org.id, () =>
        handler({ org_id: otherOrg.id }, restrictedAuth),
      );
      const crossOrg = JSON.parse(crossOrgRaw);
      expect(crossOrg.error).toBeDefined();

      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () => handler({}, unrestrictedAuth));
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedSerials = unrestricted.events.map((e: any) => e.serialNumber);
      expect(unrestrictedSerials).toContain('in-scope-serial');
      expect(unrestrictedSerials).toContain('out-scope-serial');
    });
  });

  // ------------------------------------------------------------------
  // get_sensitive_data_overview
  // ------------------------------------------------------------------
  describe('get_sensitive_data_overview', () => {
    it('site-restricted caller: hides out-of-site, shows in-site, denies cross-org, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeDevice = await seedDevice(org.id, siteAllowed.id);
      const outScopeDevice = await seedDevice(org.id, siteForbidden.id);
      const otherOrgSite = await createSite({ orgId: otherOrg.id });
      const otherOrgDevice = await seedDevice(otherOrg.id, otherOrgSite.id);

      const [inScopeScan] = await getTestDb()
        .insert(sensitiveDataScans)
        .values({ orgId: org.id, deviceId: inScopeDevice.id, status: 'completed' })
        .returning();
      const [outScopeScan] = await getTestDb()
        .insert(sensitiveDataScans)
        .values({ orgId: org.id, deviceId: outScopeDevice.id, status: 'completed' })
        .returning();
      const [otherOrgScan] = await getTestDb()
        .insert(sensitiveDataScans)
        .values({ orgId: otherOrg.id, deviceId: otherOrgDevice.id, status: 'completed' })
        .returning();

      await getTestDb().insert(sensitiveDataFindings).values([
        {
          orgId: org.id,
          deviceId: inScopeDevice.id,
          scanId: inScopeScan!.id,
          filePath: '/in-scope/file.txt',
          dataType: 'pii',
          patternId: 'ssn',
          risk: 'high',
        },
        {
          orgId: org.id,
          deviceId: outScopeDevice.id,
          scanId: outScopeScan!.id,
          filePath: '/out-scope/file.txt',
          dataType: 'pii',
          patternId: 'ssn',
          risk: 'high',
        },
        {
          orgId: otherOrg.id,
          deviceId: otherOrgDevice.id,
          scanId: otherOrgScan!.id,
          filePath: '/other-org/file.txt',
          dataType: 'pii',
          patternId: 'ssn',
          risk: 'high',
        },
      ]);

      const handler = handlerFor(registerSecurityTools, 'get_sensitive_data_overview');

      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () =>
        handler({ view: 'findings' }, restrictedAuth),
      );
      const restricted = JSON.parse(restrictedRaw);
      const restrictedPaths = restricted.findings.map((f: any) => f.filePath);
      expect(restrictedPaths).toContain('/in-scope/file.txt');
      expect(restrictedPaths).not.toContain('/out-scope/file.txt');
      expect(restrictedPaths).not.toContain('/other-org/file.txt');

      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () =>
        handler({ view: 'findings' }, unrestrictedAuth),
      );
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedPaths = unrestricted.findings.map((f: any) => f.filePath);
      expect(unrestrictedPaths).toContain('/in-scope/file.txt');
      expect(unrestrictedPaths).toContain('/out-scope/file.txt');
    });

    it('fails closed (dashboard + findings views) when a site-restricted caller has no resolvable org', async () => {
      const handler = handlerFor(registerSecurityTools, 'get_sensitive_data_overview');
      const auth = makeAuth(null, [randomUUID()]);

      const dashboardRaw = await withNoOrgContext(() => handler({ view: 'dashboard' }, auth));
      expect(JSON.parse(dashboardRaw)).toEqual({
        view: 'dashboard',
        totals: { findings: 0, open: 0, criticalOpen: 0, remediated24h: 0, averageOpenAgeHours: 0 },
        byDataType: {},
        byRisk: {},
      });

      const findingsRaw = await withNoOrgContext(() => handler({ view: 'findings' }, auth));
      expect(JSON.parse(findingsRaw)).toEqual({ view: 'findings', totalReturned: 0, findings: [] });
    });
  });

  // ------------------------------------------------------------------
  // get_user_risk_scores + get_user_risk_detail
  // ------------------------------------------------------------------
  describe('get_user_risk_scores / get_user_risk_detail', () => {
    // These two tools have NO device axis; "site" here means the SUBJECT
    // user's own `organization_users.site_ids` membership overlapping the
    // caller's `allowedSiteIds` — not a device's site.
    async function seedRiskUser(orgId: string, partnerId: string, siteIds: string[]) {
      const database = getTestDb();
      const [user] = await database
        .insert(users)
        .values({
          partnerId,
          orgId,
          email: `risk-${randomUUID()}@example.com`,
          name: `Risk User ${randomUUID().slice(0, 8)}`,
          passwordHash: 'not-a-real-hash',
          status: 'active',
        })
        .returning();
      const role = await createRole({ scope: 'organization', orgId, partnerId });
      await database.insert(organizationUsers).values({
        orgId,
        userId: user!.id,
        roleId: role.id,
        siteIds,
      });
      await database.insert(userRiskScores).values({
        orgId,
        userId: user!.id,
        score: 75,
        calculatedAt: new Date(),
      });
      return user!;
    }

    it('get_user_risk_scores: site-restricted caller sees in-scope subject, hides out-of-scope, unrestricted sees both', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });

      const inScopeUser = await seedRiskUser(org.id, partner.id, [siteAllowed.id]);
      const outScopeUser = await seedRiskUser(org.id, partner.id, [siteForbidden.id]);

      const handler = handlerFor(registerUserRiskTools, 'get_user_risk_scores');

      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const restrictedRaw = await withOrgContext(org.id, () => handler({}, restrictedAuth));
      const restricted = JSON.parse(restrictedRaw);
      const restrictedEmails = restricted.users.map((u: any) => u.userEmail);
      expect(restrictedEmails).toContain(inScopeUser.email);
      expect(restrictedEmails).not.toContain(outScopeUser.email);

      const unrestrictedAuth = makeAuth(org.id, undefined);
      const unrestrictedRaw = await withOrgContext(org.id, () => handler({}, unrestrictedAuth));
      const unrestricted = JSON.parse(unrestrictedRaw);
      const unrestrictedEmails = unrestricted.users.map((u: any) => u.userEmail);
      expect(unrestrictedEmails).toContain(inScopeUser.email);
      expect(unrestrictedEmails).toContain(outScopeUser.email);
    });

    it('get_user_risk_scores: a cross-org user is never returned', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const otherOrgSite = await createSite({ orgId: otherOrg.id });

      const otherOrgUser = await seedRiskUser(otherOrg.id, partner.id, [otherOrgSite.id]);

      const handler = handlerFor(registerUserRiskTools, 'get_user_risk_scores');
      const auth = makeAuth(org.id, undefined);
      const raw = await withOrgContext(org.id, () => handler({}, auth));
      const parsed = JSON.parse(raw);
      const emails = parsed.users.map((u: any) => u.userEmail);
      expect(emails).not.toContain(otherOrgUser.email);
    });

    it('get_user_risk_detail: site-restricted caller sees in-scope subject, not-found for out-of-scope, unrestricted sees both, and cross-org not found', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: partner.id });
      const siteAllowed = await createSite({ orgId: org.id });
      const siteForbidden = await createSite({ orgId: org.id });
      const otherOrgSite = await createSite({ orgId: otherOrg.id });

      const inScopeUser = await seedRiskUser(org.id, partner.id, [siteAllowed.id]);
      const outScopeUser = await seedRiskUser(org.id, partner.id, [siteForbidden.id]);
      const otherOrgUser = await seedRiskUser(otherOrg.id, partner.id, [otherOrgSite.id]);

      const handler = handlerFor(registerUserRiskTools, 'get_user_risk_detail');

      // (i) out-of-site subject: not found
      const restrictedAuth = makeAuth(org.id, [siteAllowed.id]);
      const outScopeRaw = await withOrgContext(org.id, () =>
        handler({ userId: outScopeUser.id }, restrictedAuth),
      );
      const outScopeParsed = JSON.parse(outScopeRaw);
      expect(outScopeParsed.userRisk).toBeUndefined();

      // (ii) in-site subject: visible, non-vacuous control
      const inScopeRaw = await withOrgContext(org.id, () =>
        handler({ userId: inScopeUser.id }, restrictedAuth),
      );
      const inScopeParsed = JSON.parse(inScopeRaw);
      expect(inScopeParsed.userRisk).toBeDefined();
      expect(inScopeParsed.userRisk.user.email).toBe(inScopeUser.email);

      // (iii) cross-org subject: not found (auth stays scoped to `org`)
      const crossOrgRaw = await withOrgContext(org.id, () =>
        handler({ userId: otherOrgUser.id }, restrictedAuth),
      );
      const crossOrgParsed = JSON.parse(crossOrgRaw);
      expect(crossOrgParsed.userRisk).toBeUndefined();

      // (iv) unrestricted caller sees both in-org subjects
      const unrestrictedAuth = makeAuth(org.id, undefined);
      const bothRaw = await Promise.all(
        [inScopeUser.id, outScopeUser.id].map((userId) =>
          withOrgContext(org.id, () => handler({ userId }, unrestrictedAuth)),
        ),
      );
      for (const raw of bothRaw) {
        expect(JSON.parse(raw).userRisk).toBeDefined();
      }
    });
  });
});
