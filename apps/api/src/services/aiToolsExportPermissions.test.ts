import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPORT_DATASET_REQUIREMENTS,
  LEGACY_EXPORT_GRANTS,
  resolveExportGrants,
  withheldSensitiveGates,
} from './aiToolsExportPermissions';

const SEVEN = ['event_logs', 'agent_logs', 'device_inventory', 'software_inventory', 'metrics', 'vulnerabilities', 'custom_fields'];

describe('EXPORT_DATASET_REQUIREMENTS', () => {
  it('every existing dataset needs devices:read; event_logs gates security rows on devices:execute', () => {
    for (const d of SEVEN) {
      expect(EXPORT_DATASET_REQUIREMENTS[d as keyof typeof EXPORT_DATASET_REQUIREMENTS].permission)
        .toEqual({ resource: 'devices', action: 'read' });
    }
    expect(EXPORT_DATASET_REQUIREMENTS.event_logs.sensitiveGate).toEqual({
      gate: 'security_events',
      permission: { resource: 'devices', action: 'execute' },
    });
    expect(SEVEN.filter((d) => d !== 'event_logs')
      .every((d) => !EXPORT_DATASET_REQUIREMENTS[d as 'agent_logs'].sensitiveGate)).toBe(true);
  });

  it('legacy grants are the ORIGINAL SEVEN as a literal, with no gate (they must not grow when W04/W05 add datasets)', () => {
    expect(LEGACY_EXPORT_GRANTS).toEqual({ datasets: SEVEN, sensitiveGates: [] });
  });

  it('legacy grants are frozen so no caller can widen them at runtime', () => {
    expect(Object.isFrozen(LEGACY_EXPORT_GRANTS)).toBe(true);
    expect(Object.isFrozen(LEGACY_EXPORT_GRANTS.datasets)).toBe(true);
    expect(Object.isFrozen(LEGACY_EXPORT_GRANTS.sensitiveGates)).toBe(true);
  });

  it('is a zero-runtime-import leaf: every import is `import type`', () => {
    const src = readFileSync(join(import.meta.dirname, 'aiToolsExportPermissions.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^import\s/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((l) => l.startsWith('import type '))).toBe(true);
  });
});

describe('resolveExportGrants', () => {
  it('a ceiling holding devices:read and devices:execute gets every dataset and the security gate', () => {
    expect(resolveExportGrants(() => true)).toEqual({ datasets: SEVEN, sensitiveGates: ['security_events'] });
  });

  it('devices:read without devices:execute: every dataset, no gate', () => {
    expect(resolveExportGrants((r, a) => r === 'devices' && a === 'read')).toEqual({ datasets: SEVEN, sensitiveGates: [] });
  });

  it('a ceiling without devices:read gets nothing, and holds no gate for a dataset it cannot export', () => {
    expect(resolveExportGrants((r, a) => r === 'devices' && a === 'execute')).toEqual({ datasets: [], sensitiveGates: [] });
  });

  it('a ceiling holding nothing gets nothing', () => {
    expect(resolveExportGrants(() => false)).toEqual({ datasets: [], sensitiveGates: [] });
  });
});

describe('withheldSensitiveGates', () => {
  it('names a gate a permitted dataset declares and the grants lack', () => {
    expect(withheldSensitiveGates(['event_logs'], { datasets: SEVEN, sensitiveGates: [] })).toEqual(['security_events']);
    expect(withheldSensitiveGates(['event_logs'], { datasets: SEVEN, sensitiveGates: ['security_events'] })).toEqual([]);
    expect(withheldSensitiveGates(['metrics'], LEGACY_EXPORT_GRANTS)).toEqual([]);
  });

  it('deduplicates and ignores names that are not datasets', () => {
    expect(withheldSensitiveGates(['event_logs', 'event_logs', 'not_a_dataset'], LEGACY_EXPORT_GRANTS))
      .toEqual(['security_events']);
  });
});
