import { describe, expect, it } from 'vitest';
import {
  DECLARED_CONTROL_CATALOG, DECLARED_CONTROL_IDS, TRUST_DECLARATION_REMINDER_DAYS, TRUST_DECLARATION_TTL_DAYS, declaredControlById,
} from './declaredCatalog';
import { TELEMETRY_CONTROL_IDS, TRUST_CONTROL_CATEGORY_ORDER } from './types';

describe('declared control catalog', () => {
  it('declares 8 controls, ids disjoint from telemetry, source declared', () => {
    expect(DECLARED_CONTROL_CATALOG.map((c) => c.id)).toEqual([...DECLARED_CONTROL_IDS]);
    expect(DECLARED_CONTROL_IDS).toHaveLength(8);
    expect(DECLARED_CONTROL_IDS.some((id) => (TELEMETRY_CONTROL_IDS as readonly string[]).includes(id))).toBe(false);
    expect(DECLARED_CONTROL_CATALOG.every((c) => c.source === 'declared')).toBe(true);
  });

  it('TTL constants match spec §18.2', () => {
    expect(TRUST_DECLARATION_TTL_DAYS).toBe(365);
    expect(TRUST_DECLARATION_REMINDER_DAYS).toBe(30);
  });

  it('adds the governance category last and files each declaration under its plan category', () => {
    expect(TRUST_CONTROL_CATEGORY_ORDER[TRUST_CONTROL_CATEGORY_ORDER.length - 1]).toBe('governance');
    for (const id of ['security_awareness_training', 'incident_response_plan', 'vendor_risk_management', 'penetration_test', 'cyber_insurance'] as const) {
      expect(declaredControlById(id)?.category, id).toBe('governance');
    }
    expect(declaredControlById('data_inventory')?.category).toBe('data_protection');
    expect(declaredControlById('backup_recovery_plan')?.category).toBe('data_protection');
    expect(declaredControlById('access_review')?.category).toBe('identity_access');
    expect(declaredControlById('nope' as never)).toBeUndefined();
  });

  it('cyber insurance maps to no framework; every other declaration maps to CIS and NIST', () => {
    expect(declaredControlById('cyber_insurance')?.frameworkRefs).toEqual([]);
    for (const c of DECLARED_CONTROL_CATALOG.filter((d) => d.id !== 'cyber_insurance')) {
      expect(c.frameworkRefs.some((r) => r.framework === 'cis_v8'), c.id).toBe(true);
      expect(c.frameworkRefs.some((r) => r.framework === 'nist_csf_2'), c.id).toBe(true);
    }
  });

  it('copy is present and never implies certification', () => {
    for (const c of DECLARED_CONTROL_CATALOG) {
      expect(c.title.length).toBeGreaterThan(3);
      expect(c.description.length).toBeGreaterThan(10);
      expect(`${c.title} ${c.description}`).not.toMatch(/compliant with|certified|meets IG/i);
    }
  });
});
