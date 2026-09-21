import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  CONVERSION_PREREQUISITES,
  ConversionPrerequisiteMissingError,
  assertConversionPrerequisites,
  missingConversionPrerequisites,
} from './prerequisites';

const SRC = resolve(__dirname, '../../..');

describe('conversion prerequisites (spec §Risks: converter refuses until #6342/#6343/#6344 are present)', () => {
  it('all three checks pass on this tree', () => {
    expect(missingConversionPrerequisites()).toEqual([]);
    expect(() => assertConversionPrerequisites()).not.toThrow();
    expect(CONVERSION_PREREQUISITES.map((p) => p.id)).toEqual(['#6342', '#6343', '#6344']);
  });

  it('#6342 — offlineAlertEffects resolves monitors for the device (the capability constant sits next to that code)', () => {
    const src = readFileSync(resolve(SRC, 'services/offlineAlertEffects.ts'), 'utf8');
    expect(src).toContain('await getApplicableRules(device.id)');
    const service = readFileSync(resolve(SRC, 'services/alertService.ts'), 'utf8');
    expect(service).toContain('await resolveMonitorsForDevice(deviceId)');
    expect(src).toContain('export const OFFLINE_EFFECTS_RESOLVE_MONITORS = true');
  });

  it('#6344 — the resolver applies assignment role/OS filters', () => {
    const src = readFileSync(resolve(SRC, 'services/monitors/monitorResolver.ts'), 'utf8');
    expect(src).toMatch(/buildRoleOsFilterConditions|matchesRoleOsFilter/);
    expect(src).toContain('MONITOR_RESOLVER_CAPABILITIES');
  });

  it('a failing check names the fix and blocks', () => {
    const broken = [{ id: '#6343' as const, label: '#6343 restart params preserved', check: () => false }];
    expect(missingConversionPrerequisites(broken)).toEqual(['#6343 restart params preserved']);
    expect(() => assertConversionPrerequisites(broken)).toThrow(ConversionPrerequisiteMissingError);
  });
});
