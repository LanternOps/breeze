import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next from 'i18next';
import type { BackupOverviewDto, DashboardDto, DashboardTileKey, SecurityOverviewDto } from '@breeze/shared';
import {
  DASHBOARD_TILE_LABEL_KEYS,
  PREVIEW_SUMMARY_KEYS,
  summarizeSection,
} from './orgPortalPreviewSummary';

const localesDir = join(dirname(fileURLToPath(import.meta.url)), '../../locales');
const LOCALES = ['en', 'de-DE', 'es-419', 'fr-FR', 'fr-CA', 'it-IT', 'pt-BR', 'tr-TR'] as const;
const loadSettings = (locale: string) =>
  JSON.parse(readFileSync(join(localesDir, locale, 'settings.json'), 'utf8')) as Record<string, unknown>;

function lookup(bundle: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (node, seg) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined),
    bundle,
  );
}

const i18n = i18next.createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { settings: loadSettings('en') } },
  defaultNS: 'settings',
  interpolation: { escapeValue: false },
});
const t = i18n.getFixedT('en', 'settings');

/** Every tile the portal dashboard DTO can carry (Required<> forces the optional ones). */
const FULL_DASHBOARD = {
  asOf: '2026-10-23T12:00:00.000Z',
  timezone: 'UTC',
  securityScore: { status: 'ok', score: 69, band: 'good', delta30d: 2, capturedAt: '2026-10-23T00:00:00.000Z' },
  devicesProtected: { status: 'ok', protected: 8, unprotected: 1, unknown: 1, total: 10, asOf: '2026-10-23T00:00:00.000Z' },
  patchesApplied: { status: 'ok', applied: 42, devicesWithOutstandingCritical: 1, month: '2026-10', timezone: 'UTC', asOf: '2026-10-23T00:00:00.000Z' },
  backup: { status: 'ok', completedAt: '2026-10-22T03:00:00.000Z', verificationType: 'test_restore', configured: 9, total: 10, asOf: '2026-10-23T00:00:00.000Z' },
  support: { status: 'ok', openTickets: 3, averageFirstResponseMinutes: 12, sampleSize: 4, month: '2026-10', timezone: 'UTC', asOf: '2026-10-23T00:00:00.000Z' },
  actionItems: { status: 'ok', count: 5, topIssues: ['x'], asOf: '2026-10-23T00:00:00.000Z' },
  awaitingYou: { status: 'ok', proposals: 1, invoices: 2, asOf: '2026-10-23T00:00:00.000Z' },
  service: { status: 'ok', windowDays: 90, deliveredOnTime: 7, deliveredLate: 1, missed: 0, nextDue: null, asOf: '2026-10-23T00:00:00.000Z' },
} satisfies Required<DashboardDto>;

const RAW_KEY = /^[a-z]+[A-Z][A-Za-z]*$/; // camelCase identifier, e.g. "securityScore"
/** Every field name inside a dashboard tile DTO ("status", "score", "openTickets", ...). */
const DTO_FIELDS = [...new Set(Object.values(FULL_DASHBOARD).flatMap((v) => (typeof v === 'object' ? Object.keys(v) : [])))];

describe('orgPortalPreviewSummary (#9952)', () => {
  it('has a label for every dashboard tile key the portal DTO can return, in every locale', () => {
    const tileKeys = Object.keys(FULL_DASHBOARD).filter((k) => k !== 'asOf' && k !== 'timezone') as DashboardTileKey[];
    expect(Object.keys(DASHBOARD_TILE_LABEL_KEYS).sort()).toEqual([...tileKeys].sort());
    for (const locale of LOCALES) {
      const bundle = loadSettings(locale);
      for (const key of PREVIEW_SUMMARY_KEYS) {
        const value = lookup(bundle, key) ?? lookup(bundle, `${key}_other`);
        expect(typeof value, `${locale}: ${key}`).toBe('string');
        expect(String(value).length, `${locale}: ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('renders every dashboard tile with a human label and value, never a raw key', () => {
    const rows = summarizeSection('dashboard', FULL_DASHBOARD, t);
    expect(rows).toHaveLength(Object.keys(DASHBOARD_TILE_LABEL_KEYS).length);
    for (const row of rows) {
      expect(row.label).not.toMatch(RAW_KEY);
      expect(row.label).not.toContain('orgPortalSettingsEditor');
      // The pre-fix generic renderer emitted DTO "field: value" pairs ("status: ok · score: 69").
      for (const field of DTO_FIELDS) expect(row.value).not.toContain(`${field}:`);
      expect(row.value).not.toContain('orgPortalSettingsEditor');
    }
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Security score']).toBe('69 (Good)');
    expect(byLabel['Endpoint protection']).toBe('8 of 10 protected · 1 not yet known');
    expect(byLabel['Patches applied this month']).toBe('42');
    expect(byLabel['Action items']).toBe('5');
    expect(byLabel['Support']).toBe('3 open requests');
    expect(byLabel['Awaiting your customer']).toBe('Proposals: 1 · Invoices: 2');
    expect(byLabel['Service delivered (90 days)']).toBe('On time: 7 · Late: 1 · Missed: 0');
    expect(byLabel['Last backup verified']).toMatch(/2026/);
  });

  it('shows the portal\'s "unavailable" wording for non-ok or empty tiles instead of the raw status', () => {
    const rows = summarizeSection('dashboard', {
      securityScore: { status: 'ok', score: null, band: null, delta30d: null, capturedAt: null },
      devicesProtected: { status: 'not_configured', protected: null, unprotected: null, unknown: null, total: null, asOf: null },
      actionItems: { status: 'stale', count: 4, topIssues: [], asOf: 'x' },
      support: { status: 'ok', openTickets: 1, averageFirstResponseMinutes: null, sampleSize: 0, month: 'm', timezone: 'UTC', asOf: 'x' },
    }, t);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Security score']).toBe('Not yet available');
    expect(byLabel['Endpoint protection']).toBe('Not set up');
    expect(byLabel['Action items']).toBe('4 · May be out of date');
    expect(byLabel['Support']).toBe('1 open request');
  });

  it('mirrors the portal for partial tiles: no invented zeros, unknown fleets, unknown statuses', () => {
    const rows = summarizeSection('dashboard', {
      devicesProtected: { status: 'ok', protected: 0, unprotected: 0, unknown: 10, total: 10, asOf: null },
      actionItems: { status: 'stale', count: null, topIssues: [], asOf: 'x' },
      patchesApplied: { status: 'mystery', applied: null },
      awaitingYou: { status: 'ok', proposals: null, invoices: 2, asOf: 'x' },
      service: { status: 'ok', windowDays: 90, deliveredOnTime: null, deliveredLate: null, missed: null,
        nextDue: { name: 'Quarterly review', dueAt: '2026-11-03T12:00:00.000Z' }, asOf: 'x' },
    }, t);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Endpoint protection']).toBe('Not yet known for all 10 devices');
    expect(byLabel['Action items']).toBe('May be out of date');
    expect(byLabel['Patches applied this month']).toBe('Not yet available');
    expect(byLabel['Awaiting your customer']).toBe('Not yet available');
    expect(byLabel['Service delivered (90 days)']).toMatch(/^Next due: Quarterly review, .*2026/);

    const partialService = summarizeSection('dashboard', {
      service: { status: 'ok', windowDays: 90, deliveredOnTime: 3, deliveredLate: null, missed: 1, nextDue: null, asOf: 'x' },
    }, t);
    expect(partialService[0].value).toBe('Not yet available');
  });

  it('formats tile dates in the org timezone the dashboard names, as the portal does', () => {
    const tile = { status: 'ok', completedAt: '2026-10-22T03:00:00.000Z', verificationType: null, configured: 1, total: 1, asOf: 'x' };
    const la = summarizeSection('dashboard', { timezone: 'America/Los_Angeles', backup: tile }, t)[0].value;
    const akl = summarizeSection('dashboard', { timezone: 'Pacific/Auckland', backup: tile }, t)[0].value;
    expect(la).toMatch(/21/);
    expect(akl).toMatch(/22/);
  });

  it('summarizes the Security section with labels, not DTO field names', () => {
    const security: SecurityOverviewDto = {
      dataStatus: 'ok',
      asOf: '2026-10-23T00:00:00.000Z',
      score: 69,
      band: 'at_risk',
      scoreHistory: [{ capturedAt: '2026-10-01T00:00:00.000Z', score: 60 }],
      threatEvents: {
        label: 'Endpoint threat events',
        weeks: [
          { weekStart: '2026-10-05', detected: 2, resolved: 1, detectedBySource: { native: 2, sentinelOne: 0, huntress: 0 }, resolvedBySource: { native: 1, sentinelOne: 0, huntress: 0 } },
          { weekStart: '2026-10-12', detected: 1, resolved: 2, detectedBySource: { native: 1, sentinelOne: 0, huntress: 0 }, resolvedBySource: { native: 2, sentinelOne: 0, huntress: 0 } },
        ],
      },
      vulnerabilities: { openBySeverity: { critical: 1, high: 3 }, kevCount: 2, lastDetectedAt: null },
    };
    const rows = summarizeSection('security', security, t);
    expect(rows).toEqual([
      { label: 'Security score', value: '69 (At risk)' },
      { label: 'Open vulnerabilities', value: '4' },
      { label: 'Known exploited (KEV)', value: '2' },
      { label: 'Endpoint threat events', value: 'Detected: 3 · Resolved: 3' },
    ]);
  });

  it('summarizes the Backups section with labels, not DTO field names', () => {
    const backups = {
      dataStatus: 'ok',
      asOf: '2026-10-23T00:00:00.000Z',
      protected: 7,
      unprotected: 3,
      total: 10,
      lastPassedVerification: { completedAt: '2026-10-22T03:00:00.000Z', verificationType: 'integrity' },
      lastTestRestoreAt: null,
      openRpoBreaches: 1,
      openRtoBreaches: 0,
      meanReadinessScore: null,
      lastTestRestoreStatus: null,
      readinessScoredDevices: null,
      readinessTotalDevices: null,
      byHealth: {} as BackupOverviewDto['byHealth'],
      externalProviders: ['Cove', 'Datto'],
    } satisfies BackupOverviewDto;
    const rows = summarizeSection('backups', backups, t);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Devices backed up']).toBe('7 of 10 protected');
    expect(byLabel['Last backup verified']).toMatch(/2026/);
    expect(byLabel['Open RPO / RTO breaches']).toBe('RPO 1 · RTO 0');
    expect(byLabel['Third-party backup']).toBe('Cove, Datto');
    for (const row of rows) expect(row.label).not.toMatch(RAW_KEY);
  });

  it('does not invent zero counts for a Security section with no data, and shows a bare score for an unknown band', () => {
    const empty = summarizeSection('security', {
      dataStatus: 'no_data', asOf: 'x', score: null, band: null, scoreHistory: [],
      threatEvents: { label: 'Endpoint threat events', weeks: [] },
      vulnerabilities: { openBySeverity: {}, kevCount: 0, lastDetectedAt: null },
    }, t);
    expect(empty).toEqual([{ label: 'Security score', value: 'Not yet available' }]);
    const bare = summarizeSection('security', { dataStatus: 'ok', score: 55, band: 'weird' }, t);
    expect(bare).toEqual([{ label: 'Security score', value: '55' }]);
  });

  it('labels a Backups section that is not configured instead of printing nulls', () => {
    const rows = summarizeSection('backups', {
      dataStatus: 'not_configured', asOf: 'x', protected: null, unprotected: null, total: null,
      lastPassedVerification: null, openRpoBreaches: null, openRtoBreaches: null, externalProviders: [],
    }, t);
    expect(rows).toEqual([
      { label: 'Devices backed up', value: 'Not set up' },
      { label: 'Last backup verified', value: 'Not yet available' },
    ]);
  });

  it('renders nothing (rather than raw keys) for a section it has no summary for', () => {
    expect(summarizeSection('hardwareHealth', { someField: { status: 'ok', count: 1 } }, t)).toEqual([]);
  });
});
