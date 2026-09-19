import { describe, expect, it, vi } from 'vitest';

// #5784 W01: the predicate must key on the DEFINITION (the org's one managed
// evidence definition), not on the type — a managed evidence type will have
// both user-authored definitions and the org's managed one. The registry is
// empty in W01, so a fake entry stands in for W02's first real type.
vi.mock('../../services/managedEvidenceRegistry', () => ({
  isManagedEvidenceType: (v: string) => v === 'threat_detection_review',
}));

import { isSystemManagedReportDefinition } from './helpers';

describe('isSystemManagedReportDefinition (#4190 + #5784)', () => {
  it('does not lock a technician out of their own report of a managed evidence type', () => {
    // A user-authored report of a managed evidence type is NOT portal_self_service
    // and must remain fully editable. Only the org's one managed definition is
    // protected.
    expect(isSystemManagedReportDefinition({
      type: 'threat_detection_review', executionScopePrincipalKind: 'user', portalSelfService: false,
    })).toBe(false);
    expect(isSystemManagedReportDefinition({
      type: 'threat_detection_review', executionScopePrincipalKind: 'user', portalSelfService: true,
    })).toBe(true);
  });

  it('still protects the stored-artifact-only types by type alone', () => {
    expect(isSystemManagedReportDefinition({ type: 'ai_org_narrative', executionScopePrincipalKind: 'user', portalSelfService: false })).toBe(true);
    expect(isSystemManagedReportDefinition({ type: 'ai_fleet_design', executionScopePrincipalKind: 'user', portalSelfService: false })).toBe(true);
  });

  it('still protects any system-principal definition of an ordinary type', () => {
    expect(isSystemManagedReportDefinition({ type: 'device_inventory', executionScopePrincipalKind: 'system', portalSelfService: false })).toBe(true);
  });

  it('leaves the ordinary portal self-service catalog definitions unprotected by this predicate', () => {
    // Those are guarded by PORTAL_SELF_SERVICE_REPORT on generate only; PUT and
    // DELETE stay open to the MSP as they are today.
    expect(isSystemManagedReportDefinition({ type: 'executive_summary', executionScopePrincipalKind: 'user', portalSelfService: true })).toBe(false);
  });

  it('treats a row without the portalSelfService column as not managed-evidence-protected', () => {
    expect(isSystemManagedReportDefinition({ type: 'threat_detection_review', executionScopePrincipalKind: 'user' })).toBe(false);
  });
});
