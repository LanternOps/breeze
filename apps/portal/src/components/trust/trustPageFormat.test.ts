import { describe, expect, it } from 'vitest';
import { cardMeta, notAssessedReasonCopy, coverageNote, frameworkChip, groupControlsByCategory, relativeTime } from './trustPageFormat';
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
  it('not-assessed copy follows the floor and unit', () => {
    expect(notAssessedReasonCopy('insufficient_telemetry', { coverageFloorPct: 80, unit: 'devices' })).toBe('Fewer than 80% of eligible devices reported inside the evidence window');
    expect(notAssessedReasonCopy('insufficient_telemetry', { coverageFloorPct: 90, unit: 'users' })).toBe('Fewer than 90% of eligible users reported inside the evidence window');
    expect(notAssessedReasonCopy('insufficient_telemetry', { coverageFloorPct: 80, unit: 'org' })).toMatch(/eligible sources/);
  });
  describe('de-DE', () => {
    it('localizes category, coverage, chip, reason and relative time', () => {
      const g = groupControlsByCategory([ctl({})], 'de-DE');
      expect(g[0].label).toBe('Datenschutz und Datensicherung');
      expect(coverageNote(ctl({ assessed: 46, eligible: 50 }), 'de-DE')).toBe('46 von 50 Geräte bewertet');
      const chip = frameworkChip({ framework: 'essential_eight', ref: 'mfa' }, 'de-DE');
      expect(chip).toMatch(/^Essential Eight: /);
      expect(chip).not.toContain('Multi-factor authentication');
      expect(notAssessedReasonCopy('no_data', { coverageFloorPct: 80, unit: 'devices' }, 'de-DE')).toMatch(/Nachweise/);
      const now = new Date('2026-10-13T12:00:00Z');
      expect(relativeTime('2026-10-13T10:00:00Z', now, 'de-DE')).toBe('vor 2 Stunden');
      expect(relativeTime(null, now, 'de-DE')).toBe('nie');
    });
    it('SSR card meta: lang, localized title and description; unknown locale and missing card are English', () => {
      const card = { orgName: 'Acme', locale: 'de-DE', controlsShown: 3, catalogTotal: 15, controlsMet: 1 };
      const m = cardMeta(card);
      expect(m.lang).toBe('de-DE');
      expect(m.title).toBe('Acme · Sicherheitsstatus');
      expect(m.description).toContain('3 von 15');
      expect(cardMeta({ ...card, locale: 'xx-XX' }).lang).toBe('en');
      expect(cardMeta({ ...card, locale: 'xx-XX' }).title).toBe('Acme · Security posture');
      expect(cardMeta(null)).toMatchObject({ lang: 'en', title: 'Security posture', description: 'Security posture page.' });
    });
    it('an unknown locale falls back to English', () => {
      expect(coverageNote(ctl({ assessed: 1, eligible: 2 }), 'xx-XX')).toBe('1 of 2 devices assessed');
    });
  });
});
