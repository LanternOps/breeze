import { describe, expect, it } from 'vitest';
import { coverageNote, frameworkChip, groupControlsByCategory, relativeTime } from './trustPageFormat';
const ctl = (over: Record<string, unknown>) => ({ id: 'disk_encryption', category: 'data_protection', source: 'telemetry', unit: 'devices', status: 'met', reason: null, percent: null, assessed: null, eligible: null, evidenceAsOf: null, frameworkRefs: [], ...over }) as never;
describe('trustPageFormat', () => {
  it('groups in canonical category order and drops empty categories', () => {
    const g = groupControlsByCategory([ctl({ category: 'monitoring', id: 'dns_filtering' }), ctl({})]);
    expect(g.map((x) => x.category)).toEqual(['data_protection', 'monitoring']);
    expect(g[0].label).toBe('Data protection');
  });
  it('coverage note uses the unit and hides when numbers are not exposed', () => {
    expect(coverageNote(ctl({ assessed: 46, eligible: 50 }))).toBe('46 of 50 devices assessed');
    expect(coverageNote(ctl({ unit: 'users', assessed: 48, eligible: 50 }))).toBe('48 of 50 users assessed');
    expect(coverageNote(ctl({}))).toBeNull();
  });
  it('framework chips', () => {
    expect(frameworkChip({ framework: 'cis_v8', ref: '10.1' })).toBe('CIS v8 10.1 · IG1');
    expect(frameworkChip({ framework: 'essential_eight', ref: 'mfa' })).toBe('Essential Eight: Multi-factor authentication');
  });
  it('relative time', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    expect(relativeTime('2026-10-13T10:00:00Z', now)).toBe('2 hours ago');
    expect(relativeTime(null, now)).toBe('never');
  });
});
