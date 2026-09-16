import { describe, it, expect } from 'vitest';
import {
  MANAGED_EVIDENCE_REGISTRY,
  isManagedEvidenceType,
  managedEvidenceEntry,
  type ManagedEvidenceEntry,
} from './managedEvidenceRegistry';
import { reportTypeEnum } from '../db/schema/reports';

describe('managed evidence registry', () => {
  it('is closed: every key equals its own report type, and every type is a real pg enum label', () => {
    for (const [key, entry] of Object.entries(MANAGED_EVIDENCE_REGISTRY) as Array<[string, ManagedEvidenceEntry]>) {
      expect(entry.type).toBe(key);
      expect(reportTypeEnum.enumValues).toContain(entry.type);
    }
  });

  it('refuses a type that is not registered', () => {
    expect(isManagedEvidenceType('device_inventory')).toBe(false);
    expect(isManagedEvidenceType('not_a_type')).toBe(false);
    expect(() => managedEvidenceEntry('device_inventory' as never)).toThrow(/not a managed evidence type/i);
  });

  it('never admits a stored-artifact-only type', () => {
    expect(isManagedEvidenceType('ai_org_narrative')).toBe(false);
    expect(isManagedEvidenceType('ai_fleet_design')).toBe(false);
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(MANAGED_EVIDENCE_REGISTRY)).toBe(true);
  });

  it('does not admit prototype keys', () => {
    expect(isManagedEvidenceType('toString')).toBe(false);
    expect(isManagedEvidenceType('__proto__')).toBe(false);
  });

  it('stays in step with the shared validator’s list', async () => {
    const { MANAGED_EVIDENCE_REPORT_TYPES } = await import('@breeze/shared');
    expect([...MANAGED_EVIDENCE_REPORT_TYPES].sort()).toEqual(Object.keys(MANAGED_EVIDENCE_REGISTRY).sort());
  });

  // The registry and PORTAL_DEFINITIONS are two hand-maintained lists of the
  // same fact. A managed type provisioned under a different name or config than
  // the registry declares produces an artifact the deliverable cannot recognise
  // — and nothing else in the codebase compares the two. W03/W04/W06 rely on
  // this assertion as much as W02 does.
  it('PORTAL_DEFINITIONS carries every managed evidence type with the registry config', async () => {
    const { PORTAL_DEFINITIONS_FOR_TEST } = await import('./portal/reportsSelfService');
    for (const [type, entry] of Object.entries(MANAGED_EVIDENCE_REGISTRY) as Array<[string, ManagedEvidenceEntry]>) {
      const def = PORTAL_DEFINITIONS_FOR_TEST.find((d) => d.type === type);
      expect(def, `${type} missing from PORTAL_DEFINITIONS`).toBeTruthy();
      expect(def!.name).toBe(entry.definitionName);
      expect(def!.config).toEqual(entry.defaultConfig);
    }
  });
});
