import { describe, expect, it } from 'vitest';
import { PARTNER_EXPORT_RESOURCES } from './schemas';
import {
  RESOURCE_CLASSIFICATION,
  normalizeClassificationPath,
  resolveDisposition,
  shouldRunStructuralLayer,
} from './exportSafety.classification';

describe('partner export resource classification', () => {
  it('classifies every export resource', () => {
    for (const resource of PARTNER_EXPORT_RESOURCES) {
      expect(RESOURCE_CLASSIFICATION[resource]).toBeDefined();
    }
  });

  it('normalizes array indices to []', () => {
    expect(normalizeClassificationPath('disks[1].device')).toBe('disks[].device');
    expect(normalizeClassificationPath('a[0].b[12].c')).toBe('a[].b[].c');
    expect(normalizeClassificationPath('hostname')).toBe('hostname');
  });

  it('treats inventory resources as machine-observed by default', () => {
    expect(shouldRunStructuralLayer('device-inventory', 'disks[3].device')).toBe(false);
    expect(shouldRunStructuralLayer('device-software', 'software[0].name')).toBe(false);
  });

  it('treats customer-authored resources as scanned by default', () => {
    expect(shouldRunStructuralLayer('scripts', 'content')).toBe(true);
    expect(shouldRunStructuralLayer('custom-field-values', 'value')).toBe(true);
  });

  it('applies field exceptions on mixed resources', () => {
    // devices default is customer-authored, but machine identity fields are exempt
    expect(shouldRunStructuralLayer('devices', 'displayName')).toBe(true);
    expect(shouldRunStructuralLayer('devices', 'hostname')).toBe(false);
    expect(shouldRunStructuralLayer('devices', 'hardwareIdentity.serialNumber')).toBe(false);
  });

  it('resolveDisposition falls back to the resource default', () => {
    expect(resolveDisposition('devices', 'tags[]')).toBe('customer-authored');
    expect(resolveDisposition('device-inventory', 'interfaces[].name')).toBe('machine-observed');
  });
});

import { RESOURCE_CLASSIFICATION as CLASSIFICATION_FOR_CONTRACT } from './exportSafety.classification';

describe('classification completeness contract', () => {
  // Fully-populated projection samples: every array non-empty, every nullable set,
  // so each exception path is actually emitted. An empty array here would let a
  // typo'd exception key pass unnoticed — the empty-fixture defect this fix exists
  // to prevent. When a resource's projection gains a field an exception references,
  // extend its sample here.
  const POPULATED_PATHS: Partial<Record<string, string[]>> = {
    devices: ['hostname', 'displayName', 'hardwareIdentity.serialNumber',
      'hardwareIdentity.manufacturer', 'hardwareIdentity.model', 'tags[]'],
  };

  it('every exception key corresponds to a real emitted path', () => {
    for (const [resource, classification] of Object.entries(CLASSIFICATION_FOR_CONTRACT)) {
      const exceptions = classification.exceptions ?? {};
      const known = POPULATED_PATHS[resource] ?? [];
      for (const path of Object.keys(exceptions)) {
        expect(known, `${resource} exception "${path}" is not an emitted path`).toContain(path);
      }
    }
  });

  it('every resource with exceptions has a populated-path sample', () => {
    for (const [resource, classification] of Object.entries(CLASSIFICATION_FOR_CONTRACT)) {
      if (classification.exceptions && Object.keys(classification.exceptions).length > 0) {
        expect(POPULATED_PATHS[resource], `${resource} needs a populated-path sample`).toBeDefined();
      }
    }
  });
});
