import { describe, expect, it, vi } from 'vitest';

// PORTAL_DEFINITIONS_FOR_TEST lives in a module that imports `db`; never open
// a real pool from a unit test. Nothing here issues a query.
vi.mock('../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

import {
  BUSINESS_REPORT_TYPES,
  MANAGED_EVIDENCE_REPORT_TYPES,
  REPORT_TYPES,
} from '@breeze/shared';
import { MSP_STAFF_REPORT_TYPES, REPORT_GENERATORS, reportTypeDef } from './reportRegistry';
import { MANAGED_EVIDENCE_REGISTRY } from './managedEvidenceRegistry';
import { PORTAL_DEFINITIONS_FOR_TEST } from './portal/reportsSelfService';
import { UnexecutableReportScopeError } from './reportErrors';
import type {
  PartnerUserReportExecutionAuthority,
  ReportGenerationAuthority,
} from './siteScope';
import type {
  generateAlertSummaryReport,
  generateComplianceReport,
  generateDeviceInventoryReport,
  generateExecutiveSummaryReport,
  generatePerformanceReport,
  generateSoftwareInventoryReport,
} from './reportGenerationService';
import type { generateSecurityCompliancePostureReport } from './securityComplianceReport';
import type { generateHardwareLifecycleReport } from './hardwareLifecycleReport';
import type { generateThreatDetectionReport } from './threatDetectionReport';
import type { generateEndpointManagementReport } from './endpointManagementReport';
import type { generateVulnerabilityManagementReport } from './vulnerabilityManagementReport';
import type { generateIdentityAccessReport } from './identityAccessReport';

const PARTNER_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('REPORT_GENERATORS', () => {
  it('has exactly one entry per REPORT_TYPES value, keyed by its own type', () => {
    expect(Object.keys(REPORT_GENERATORS).sort()).toEqual([...REPORT_TYPES].sort());
    for (const [key, def] of Object.entries(REPORT_GENERATORS)) expect(def.type).toBe(key);
  });

  it('every entry declares at least one supported scope, and only known scopes', () => {
    for (const def of Object.values(REPORT_GENERATORS)) {
      expect(def.supportedScopes.length).toBeGreaterThan(0);
      for (const s of def.supportedScopes) expect(['organization', 'partner']).toContain(s);
    }
  });

  it('only the three #3198 business types support partner scope', () => {
    const partnerCapable = Object.values(REPORT_GENERATORS)
      .filter((d) => d.supportedScopes.includes('partner'))
      .map((d) => d.type)
      .sort();
    expect(partnerCapable).toEqual([...BUSINESS_REPORT_TYPES].sort());
  });

  // Spec §6 (2026-09-21): the registry COMPOSES with the evidence registry
  // rather than becoming a fourth hand-parallel list. This is the assertion
  // that keeps `execution` honest against all three existing twins.
  it("execution:'managed_evidence' keys equal MANAGED_EVIDENCE_REGISTRY and both its twins", () => {
    const fromRegistry = Object.values(REPORT_GENERATORS)
      .filter((d) => d.execution === 'managed_evidence').map((d) => d.type).sort();
    expect(fromRegistry).toEqual([...Object.keys(MANAGED_EVIDENCE_REGISTRY)].sort());
    expect(fromRegistry).toEqual([...MANAGED_EVIDENCE_REPORT_TYPES].sort());
    const portalManaged = PORTAL_DEFINITIONS_FOR_TEST
      .map((d) => d.type as string)
      .filter((t) => (fromRegistry as string[]).includes(t))
      .sort();
    expect(portalManaged).toEqual(fromRegistry);
  });

  it('business types are NOT managed evidence and NOT portal definitions', () => {
    for (const t of BUSINESS_REPORT_TYPES) {
      expect(REPORT_GENERATORS[t].execution).toBe('user');
      expect(Object.keys(MANAGED_EVIDENCE_REGISTRY)).not.toContain(t);
      expect(PORTAL_DEFINITIONS_FOR_TEST.map((d) => d.type as string)).not.toContain(t);
    }
  });

  it('every existing type keeps an uncapped detail-row budget', () => {
    for (const def of Object.values(REPORT_GENERATORS)) {
      const expected = (BUSINESS_REPORT_TYPES as readonly string[]).includes(def.type)
        ? 5000 : Number.POSITIVE_INFINITY;
      expect(def.detailRowCap).toBe(expected);
    }
  });

  it('no pre-#3198 type gains a permission requirement (route middleware is unchanged)', () => {
    for (const def of Object.values(REPORT_GENERATORS)) {
      if ((BUSINESS_REPORT_TYPES as readonly string[]).includes(def.type)) {
        expect(def.requiredPermissions.length).toBeGreaterThan(0);
      } else {
        expect(def.requiredPermissions).toEqual([]);
      }
    }
  });

  // Ruling F1 (#3198 W02 final review): margin, utilization, AR and SLA
  // attainment are internal to the MSP (spec §2). The audience set is exactly
  // the three business types; every other type stays visible to org callers.
  it("audience 'msp_staff' is exactly the three business types; MSP_STAFF_REPORT_TYPES derives from it", () => {
    const mspStaff = Object.values(REPORT_GENERATORS)
      .filter((d) => d.audience === 'msp_staff').map((d) => d.type).sort();
    expect(mspStaff).toEqual([...BUSINESS_REPORT_TYPES].sort());
    expect([...MSP_STAFF_REPORT_TYPES].sort()).toEqual(mspStaff);
    for (const def of Object.values(REPORT_GENERATORS)) {
      expect(['any', 'msp_staff']).toContain(def.audience);
    }
  });

  it('reportTypeDef throws a named error for an unknown type rather than returning undefined', () => {
    expect(() => reportTypeDef('not_a_type' as never)).toThrow(/not a known report type/);
  });

  it('an org-only entry reached with a partner scope refuses before importing its generator', async () => {
    const authority = {
      principalKind: 'user',
      scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER_ID },
      principalUserId: '33333333-3333-4333-8333-333333333333',
      capturedAt: new Date(),
      fingerprint: 'e'.repeat(64),
    } as ReportGenerationAuthority;
    for (const def of Object.values(REPORT_GENERATORS)) {
      if (def.supportedScopes.includes('partner')) continue;
      if (def.type === 'ai_org_narrative' || def.type === 'ai_fleet_design') continue;
      await expect(
        def.generate({ kind: 'partner', partnerId: PARTNER_ID, orgIds: [ORG_ID] }, {}, authority),
        def.type,
      ).rejects.toBeInstanceOf(UnexecutableReportScopeError);
    }
  });
});

// ── #3198 W02 addendum B5: org generators are typed to the ORG axis ──────────
// Compile-time only (tsc checks test files): each alias below fails to compile
// if a partner_wide user authority is assignable to that generator's authority
// parameter. The org generators read `kind === 'restricted' ? scope : null`,
// so a partner_wide scope reaching one would read as whole-org.
type AuthorityParam<F extends (...args: never[]) => unknown> = Parameters<F>[2];
type RefusesPartnerAxis<F extends (...args: never[]) => unknown> =
  PartnerUserReportExecutionAuthority extends AuthorityParam<F> ? never : true;
type OrgAxisOnly = {
  deviceInventory: RefusesPartnerAxis<typeof generateDeviceInventoryReport>;
  softwareInventory: RefusesPartnerAxis<typeof generateSoftwareInventoryReport>;
  alertSummary: RefusesPartnerAxis<typeof generateAlertSummaryReport>;
  compliance: RefusesPartnerAxis<typeof generateComplianceReport>;
  performance: RefusesPartnerAxis<typeof generatePerformanceReport>;
  executiveSummary: RefusesPartnerAxis<typeof generateExecutiveSummaryReport>;
  securityCompliance: RefusesPartnerAxis<typeof generateSecurityCompliancePostureReport>;
  hardwareLifecycle: RefusesPartnerAxis<typeof generateHardwareLifecycleReport>;
  threatDetection: RefusesPartnerAxis<typeof generateThreatDetectionReport>;
  endpointManagement: RefusesPartnerAxis<typeof generateEndpointManagementReport>;
  vulnerabilityManagement: RefusesPartnerAxis<typeof generateVulnerabilityManagementReport>;
  identityAccess: RefusesPartnerAxis<typeof generateIdentityAccessReport>;
};
const ORG_AXIS_ONLY: OrgAxisOnly = {
  deviceInventory: true, softwareInventory: true, alertSummary: true, compliance: true,
  performance: true, executiveSummary: true, securityCompliance: true, hardwareLifecycle: true,
  threatDetection: true, endpointManagement: true, vulnerabilityManagement: true, identityAccess: true,
};

describe('org-axis authority narrowing (#3198 W02 addendum B5)', () => {
  it('the twelve org generators are typed org-axis only (the compile-time table above)', () => {
    expect(Object.values(ORG_AXIS_ONLY).every(Boolean)).toBe(true);
  });

  const partnerWide = {
    principalKind: 'user',
    scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER_ID },
    principalUserId: '33333333-3333-4333-8333-333333333333',
    capturedAt: new Date(),
    fingerprint: 'e'.repeat(64),
  } as ReportGenerationAuthority;
  const legacy = {
    principalKind: 'user',
    scope: { version: 1, kind: 'legacy_unscoped', orgId: ORG_ID },
    principalUserId: '33333333-3333-4333-8333-333333333333',
    capturedAt: new Date(),
    fingerprint: 'e'.repeat(64),
  } as ReportGenerationAuthority;

  it.each([['partner_wide', partnerWide], ['legacy_unscoped', legacy]])(
    'every org entry refuses a %s authority at the registry boundary, before its generator',
    async (_kind, authority) => {
      for (const def of Object.values(REPORT_GENERATORS)) {
        if (def.supportedScopes.includes('partner')) continue;
        if (def.type === 'ai_org_narrative' || def.type === 'ai_fleet_design') continue;
        await expect(
          def.generate({ kind: 'organization', orgId: ORG_ID }, {}, authority),
          def.type,
        ).rejects.toThrow(/requires an organization-axis authority/);
      }
    },
  );
});
