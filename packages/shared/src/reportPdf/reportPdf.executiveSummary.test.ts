import { describe, expect, it } from 'vitest';
import {
  buildExecRecommendations,
  buildExecutiveSummaryMetrics,
  buildReportPdf,
  executiveSummaryPeriodLabel,
} from './reportPdf';
import type { ExecutiveSummary } from '../types/executiveSummaryReport';

// #12045: the Executive Summary cover for a 12-device org read "4 online, 4
// offline" (four devices unaccounted for), headlined "33/100 AT RISK" from the
// share online at the instant of generation, printed "none" as if it were a
// value, coloured the same fact two ways, and never said what period it covered.

const opts = { generatedAt: 'Nov 9, 2026, 12:30 PM', timezone: 'UTC' };

/** The reported org, as the fixed generator now snapshots it. */
const reported: ExecutiveSummary = {
  org: { id: 'o1', name: 'Example Org' },
  devices: {
    total: 12,
    online: 4,
    offline: 4,
    otherStatuses: { maintenance: 2, pending: 2 },
    healthPercentage: 33,
    recentWindowDays: 7,
    recentlySeen: 11,
    recentlySeenPercentage: 92,
  },
  alerts: { total: 9, critical: 0, high: 7, resolved: 8, resolutionRate: 89 },
  period: { start: '2026-10-10T12:30:00.000Z', end: '2026-11-09T12:30:00.000Z' },
  notableAlerts: [
    { title: 'Disk C: below 5% free space', severity: 'high', status: 'active', device: 'FRONTDESK-01', triggeredAt: '2026-11-08T10:00:00.000Z' },
    { title: 'Backup job failed', severity: 'high', status: 'resolved', device: null, triggeredAt: '2026-11-02T10:00:00.000Z' },
  ],
  osDistribution: { windows: 12 },
  siteBreakdown: [{ site: 'Main Office', count: 12 }],
};

/** Same org, as a pre-#12045 snapshot stored it. */
const legacy: ExecutiveSummary = {
  org: { id: 'o1', name: 'Example Org' },
  devices: { total: 12, online: 4, offline: 4, healthPercentage: 33 },
  alerts: { total: 9, critical: 0, high: 7, resolved: 8, resolutionRate: 89 },
  osDistribution: { windows: 12 },
  siteBreakdown: [{ site: 'Main Office', count: 12 }],
};

// jsPDF writes standard-font text as cp1252 bytes; map 0x80-0x9f back so
// assertions can match the en dash and middle dot a reader sees.
const CP1252_HIGH =
  '€\u0081‚ƒ„…†‡' +
  'ˆ‰Š‹Œ\u008dŽ\u008f' +
  '\u0090‘’“”•–—' +
  '˜™š›œ\u009džŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

/** Every string drawn on page 1, in draw order. */
function drawnText(summary: ExecutiveSummary): string[] {
  const doc = buildReportPdf([], { ...opts, reportType: 'executive_summary', summary });
  const page = (doc.internal as unknown as { pages: Array<string[] | undefined> }).pages[1] ?? [];
  const out: string[] = [];
  for (const cmd of page) {
    for (const m of decodeWinAnsi(cmd).matchAll(/\((.*?)\) Tj/g)) out.push(m[1]!.replace(/\\(.)/g, '$1'));
  }
  return out;
}

const metricByLabel = (summary: ExecutiveSummary) => {
  const { deviceMetrics, alertMetrics } = buildExecutiveSummaryMetrics(summary);
  return new Map([...deviceMetrics, ...alertMetrics].filter((m) => m.label).map((m) => [m.label, m]));
};

describe('Executive Summary cover (#12045)', () => {
  it('accounts for every managed device: online + offline + other statuses = managed', () => {
    const m = metricByLabel(reported);
    const sum = ['Online now', 'Offline now', 'In maintenance', 'Pending enrollment']
      .map((label) => Number(m.get(label)?.value))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBe(Number(m.get('Managed devices')?.value));
    expect(sum).toBe(12);
  });

  it('shows the unaccounted remainder on a legacy snapshot that has no status breakdown', () => {
    const m = metricByLabel(legacy);
    expect(m.get('Other status')?.value).toBe('4');
  });

  it('headlines the share seen in the recent window, not the share online at generation', () => {
    const text = drawnText(reported);
    expect(text).toContain('92');
    expect(text).toContain('STRONG');
    expect(text).not.toContain('AT RISK');
    expect(text.join('\n')).toMatch(/last 7 days/);
  });

  it('judges the windowed figure and leaves the point-in-time online/offline counts informational', () => {
    const m = metricByLabel(reported);
    expect(m.get('Online now')?.status).toBe('neutral');
    expect(m.get('Offline now')?.status).toBe('neutral');
    expect(m.get('Seen in last 7 days')?.status).toBe('good');
  });

  it('labels targets as targets, never a bare "none" that reads as a value', () => {
    const { deviceMetrics, alertMetrics } = buildExecutiveSummaryMetrics(reported);
    const targets = [...deviceMetrics, ...alertMetrics].map((m) => m.target).filter(Boolean);
    expect(targets).not.toContain('none');
    for (const t of targets) expect(t).toMatch(/^target /);
    expect(drawnText(reported)).not.toContain('none');
  });

  it('prints the reporting period the alert figures cover', () => {
    expect(executiveSummaryPeriodLabel(reported.period, 'UTC')).toBe('Oct 10, 2026 – Nov 9, 2026');
    expect(executiveSummaryPeriodLabel({ start: null, end: null }, 'UTC')).toBe('All recorded alerts');
    expect(executiveSummaryPeriodLabel(undefined, 'UTC')).toBeNull();
    expect(drawnText(reported).join('\n')).toContain('Oct 10, 2026 – Nov 9, 2026');
  });

  it('omits Fleet composition when there is a single OS and a single site', () => {
    expect(drawnText(reported)).not.toContain('Fleet composition');
    const mixed = { ...reported, osDistribution: { windows: 10, macos: 2 } };
    expect(drawnText(mixed)).toContain('Fleet composition');
  });

  it('does not assert that unseen devices are unmonitored and unpatched', () => {
    for (const s of [reported, legacy]) {
      const recs = buildExecRecommendations(s).map((r) => r.text).join('\n');
      expect(recs).not.toMatch(/unmonitored and unpatched/);
    }
    const unseen = buildExecRecommendations({ ...reported, devices: { ...reported.devices, recentlySeen: 9, recentlySeenPercentage: 75 } });
    expect(unseen.map((r) => r.text).join('\n')).toMatch(/3 devices have not reported in for 7 days/);
  });

  it('names the critical and high alerts it counts', () => {
    const text = drawnText(reported);
    expect(text).toContain('Notable alerts');
    expect(text).toContain('Disk C: below 5% free space');
    expect(text).toContain('FRONTDESK-01');
  });

  it('draws a trend chip only against a previous run that measured the same window', () => {
    const size = (previous?: { generatedAt: string; summary: unknown }) =>
      Buffer.from(buildReportPdf([], { ...opts, reportType: 'executive_summary', summary: reported, previous }).output('arraybuffer')).byteLength;
    const none = size();
    // Legacy baseline (point-in-time share only): no chip, so no "-60" artefact.
    expect(size({ generatedAt: '2026-10-09T12:00:00Z', summary: { devices: { healthPercentage: 33 } } })).toBe(none);
    // Windowed baseline: the chip is drawn.
    expect(size({ generatedAt: '2026-10-09T12:00:00Z', summary: { devices: { healthPercentage: 33, recentlySeenPercentage: 83 } } })).toBeGreaterThan(none);
  });

  it('draws no trend chip against a previous run that had no devices', () => {
    const size = (summary: ExecutiveSummary, previous?: { generatedAt: string; summary: unknown }) =>
      Buffer.from(buildReportPdf([], { ...opts, reportType: 'executive_summary', summary, previous }).output('arraybuffer')).byteLength;
    // An empty run stores a default 100, not a measurement: a "-8" chip would be invented.
    const emptyWindowed = { devices: { total: 0, online: 0, offline: 0, healthPercentage: 100, recentWindowDays: 7, recentlySeen: 0, recentlySeenPercentage: 100 } };
    expect(size(reported, { generatedAt: '2026-10-09T12:00:00Z', summary: emptyWindowed })).toBe(size(reported));
    const emptyLegacy = { devices: { total: 0, online: 0, offline: 0, healthPercentage: 100 } };
    expect(size(legacy, { generatedAt: '2026-10-09T12:00:00Z', summary: emptyLegacy })).toBe(size(legacy));
  });

  it('labels an empty new-format snapshot with the windowed wording, not the legacy one', () => {
    const empty: ExecutiveSummary = {
      ...reported,
      devices: { total: 0, online: 0, offline: 0, otherStatuses: {}, healthPercentage: 100, recentWindowDays: 7, recentlySeen: 0, recentlySeenPercentage: 100 },
    };
    const m = metricByLabel(empty);
    expect(m.has('Online when report ran')).toBe(false);
    expect(m.get('Seen in last 7 days')?.value).toBe('N/A');
    expect(m.get('Seen in last 7 days')?.status).toBe('na');
    // A legacy snapshot keeps its own label.
    expect(metricByLabel({ ...legacy, devices: { total: 0, online: 0, offline: 0, healthPercentage: 100 } }).has('Online when report ran')).toBe(true);
  });

  it('draws no headline score for an empty fleet rather than a green 100', () => {
    const empty: ExecutiveSummary = {
      ...reported,
      devices: { total: 0, online: 0, offline: 0, otherStatuses: {}, healthPercentage: 100, recentWindowDays: 7, recentlySeen: 0, recentlySeenPercentage: 100 },
      notableAlerts: [],
    };
    const text = drawnText(empty);
    expect(text).not.toContain('/100');
    expect(text).not.toContain('STRONG');
    expect(text).toContain('Managed devices');
  });

  it('labels half-open and open periods without claiming none was configured', () => {
    expect(executiveSummaryPeriodLabel({ start: '2026-10-10T12:00:00.000Z', end: null }, 'UTC')).toBe('Since Oct 10, 2026');
    expect(executiveSummaryPeriodLabel({ start: null, end: '2026-11-09T12:00:00.000Z' }, 'UTC')).toBe('Through Nov 9, 2026');
    const open = drawnText({ ...reported, period: { start: null, end: null } }).join('\n');
    expect(open).toContain('Alert figures cover all recorded alerts.');
    expect(open).not.toMatch(/no reporting period configured/);
  });

  it('folds alert text the standard PDF font cannot draw', () => {
    const text = drawnText({
      ...reported,
      notableAlerts: [{ title: 'CPU \u2265 90% \u2192 spike \ud83d\udd25', severity: 'critical', status: 'active', device: 'H\u00d6ST-\u4e00', triggeredAt: '2026-11-08T10:00:00.000Z' }],
    });
    expect(text).toContain('CPU >= 90% -> spike ?');
    expect(text).toContain('H\u00d6ST-?');
  });

  it('accounts for every critical/high alert: rows drawn + "further" count = critical + high', () => {
    const many: ExecutiveSummary = {
      ...reported,
      devices: { ...reported.devices, otherStatuses: { maintenance: 1, pending: 1, updating: 1, quarantined: 1 }, recentlySeen: 6, recentlySeenPercentage: 50 },
      alerts: { total: 30, critical: 4, high: 8, resolved: 3, resolutionRate: 10 },
      osDistribution: { windows: 4, macos: 3, linux: 2, ios: 2, android: 1 },
      siteBreakdown: [1, 2, 3, 4, 5].map((n) => ({ site: `Site ${n}`, count: 2 })),
      notableAlerts: Array.from({ length: 5 }, (_, i) => ({
        title: `Alert number ${i + 1}`, severity: 'critical', status: 'active', device: `HOST-${i + 1}`, triggeredAt: '2026-11-08T10:00:00.000Z',
      })),
    };
    const text = drawnText(many);
    const drawn = text.filter((t) => /^Alert number \d$/.test(t)).length;
    const further = text.join('\n').match(/\+ (\d+) further critical\/high alert/);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn + Number(further?.[1] ?? 0)).toBe(12);
    expect(text).toContain('Recommended actions');
  });

  it('folds a long site list into an "other sites" row that keeps the device count', () => {
    const text = drawnText({
      ...reported,
      notableAlerts: [],
      siteBreakdown: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ site: `Site ${n}`, count: 2 })),
    });
    expect(text).toContain('Fleet composition');
    const otherIdx = text.findIndex((t) => /^\d+ other sites$/.test(t));
    expect(otherIdx).toBeGreaterThan(-1);
    const shownSites = text.filter((t) => /^Site \d$/.test(t)).length;
    const otherSites = Number(text[otherIdx]!.split(' ')[0]);
    expect(shownSites + otherSites).toBe(7);
  });

  it('words the device recommendation by count, and only when a device is unseen', () => {
    const recFor = (recentlySeen: number) =>
      buildExecRecommendations({ ...reported, devices: { ...reported.devices, recentlySeen, recentlySeenPercentage: Math.round((recentlySeen / 12) * 100) } })
        .map((r) => r.text).join('\n');
    expect(recFor(11)).toMatch(/1 device has not reported in for 7 days — its monitoring/);
    expect(recFor(12)).not.toMatch(/not reported in/);
    expect(buildExecRecommendations(legacy).map((r) => r.text).join('\n'))
      .toMatch(/Confirm the 4 devices offline when this report ran are expected to be switched off/);
  });

  it('still renders a one-page cover from a legacy snapshot', () => {
    const doc = buildReportPdf([], { ...opts, reportType: 'executive_summary', summary: legacy });
    expect(doc.getNumberOfPages()).toBe(1);
    expect(drawnText(legacy)).toContain('33');
  });
});
