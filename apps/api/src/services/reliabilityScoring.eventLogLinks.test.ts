import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {},
}));

import { reliabilityScoringInternals as I, scoreDeviceReliability } from './reliabilityScoring';

// #10053: the scorer publishes each factor's scoring window and the event-log
// sources of the events it actually scored, so the device Reliability panel can
// link a factor to exactly those events instead of reconstructing the window
// client-side and filtering by one source.

const windowEnd = new Date('2026-03-31T12:00:00.000Z');
const baseInput = { latest: null, deviceRole: 'workstation', enrolledAt: new Date('2025-01-01T00:00:00.000Z'), windowEnd };

function row(collectedAt: string, events: Record<string, unknown> = {}) {
  const at = new Date(collectedAt);
  return {
    collectedAt: at, uptimeSeconds: 3600, bootTime: new Date(at.getTime() - 3_600_000),
    crashEvents: [], appHangs: [], serviceFailures: [], hardwareErrors: [], ...events,
  };
}

function factors(details: unknown) {
  return (details as { factors: Record<string, Record<string, unknown>> }).factors;
}

describe('scoreDeviceReliability scoring windows (#10053)', () => {
  it('persists each factor window: 30 UTC day buckets for faults, 90 for uptime, ending at windowEnd', () => {
    const { values } = scoreDeviceReliability({ ...baseInput, rows: [row('2026-03-30T10:00:00.000Z')] as any, baseline: null });
    const f = factors(values.details);
    for (const name of ['crashes', 'hangs', 'serviceFailures', 'hardwareErrors']) {
      expect(f[name]).toMatchObject({ windowStart: '2026-03-01T00:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z' });
    }
    expect(f.uptime).toMatchObject({ windowStart: '2025-12-31T00:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z' });
  });

  it('clamps the window start to the baseline marker', () => {
    const baseline = { id: 'b-1', baselineAt: new Date('2026-03-20T06:00:00.000Z'), reason: 'remediated' as const, source: 'manual' as const };
    const { values } = scoreDeviceReliability({ ...baseInput, rows: [row('2026-03-30T10:00:00.000Z')] as any, baseline });
    expect(factors(values.details).crashes).toMatchObject({ windowStart: '2026-03-20T06:00:00.000Z' });
    expect(factors(values.details).uptime).toMatchObject({ windowStart: '2026-03-20T06:00:00.000Z' });
  });
});

describe('scoreDeviceReliability scored event-log sources (#10053)', () => {
  it('records the distinct sources of the in-window crash, hang and genuine hardware events', () => {
    const rows = [
      row('2026-02-28T23:30:00.000Z', {
        // Day before the window's first bucket: not scored, so not a source.
        crashEvents: [{ type: 'bsod', timestamp: '2026-02-28T23:00:00.000Z', details: { source: 'OutOfWindow' } }],
      }),
      row('2026-03-01T01:00:00.000Z', {
        crashEvents: [{ type: 'bsod', timestamp: '2026-03-01T00:30:00.000Z', details: { source: 'Microsoft-Windows-Kernel-Power', eventId: '41' } }],
      }),
      row('2026-03-10T10:00:00.000Z', {
        crashEvents: [{ type: 'bsod', timestamp: '2026-03-10T09:00:00.000Z', details: { source: 'EventLog', eventId: '6008' } }],
        appHangs: [
          { processName: 'Application Hang', timestamp: '2026-03-10T08:00:00.000Z', duration: 0, resolved: false },
          { processName: 'Application Hang', timestamp: '2026-03-10T08:30:00.000Z', duration: 0, resolved: false },
        ],
        hardwareErrors: [
          { type: 'disk', severity: 'error', timestamp: '2026-03-10T07:00:00.000Z', source: 'disk', eventId: '153' },
          // Software provider the server-side gate rejects: not scored, so not a source.
          { type: 'unknown', severity: 'error', timestamp: '2026-03-10T07:10:00.000Z', source: 'Service Control Manager', eventId: '7031' },
          { type: 'mce', severity: 'critical', timestamp: '2026-03-10T07:20:00.000Z', source: 'Microsoft-Windows-WHEA-Logger', eventId: '18' },
        ],
      }),
    ];
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: null });
    const f = factors(values.details);
    expect(values.crashCount30d).toBe(2);
    expect(f.crashes!.eventLogSources).toEqual(['EventLog', 'Microsoft-Windows-Kernel-Power']);
    expect(f.hangs!.eventLogSources).toEqual(['Application Hang']);
    expect(f.hardwareErrors!.eventLogSources).toEqual(['Microsoft-Windows-WHEA-Logger', 'disk']);
    // Service failures carry a parsed service name, not a source: no list.
    expect(f.serviceFailures!.eventLogSources).toBeUndefined();
  });

  it('records an empty list when the factor scored no events', () => {
    const { values } = scoreDeviceReliability({ ...baseInput, rows: [row('2026-03-30T10:00:00.000Z')] as any, baseline: null });
    expect(factors(values.details).crashes!.eventLogSources).toEqual([]);
  });

  it('drops pre-marker events from the source list, like the score does', () => {
    const baseline = { id: 'b-1', baselineAt: new Date('2026-03-20T00:00:00.000Z'), reason: 'remediated' as const, source: 'manual' as const };
    const rows = [row('2026-03-21T10:00:00.000Z', {
      crashEvents: [
        { type: 'bsod', timestamp: '2026-03-19T09:00:00.000Z', details: { source: 'BeforeMarker' } },
        { type: 'bsod', timestamp: '2026-03-21T09:00:00.000Z', details: { source: 'AfterMarker' } },
      ],
    })];
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline });
    expect(factors(values.details).crashes!.eventLogSources).toEqual(['AfterMarker']);
  });

  it('omits the list when a scored event has no source (the list would not cover every scored event)', () => {
    const rows = [row('2026-03-10T10:00:00.000Z', {
      crashEvents: [
        { type: 'bsod', timestamp: '2026-03-10T09:00:00.000Z', details: { source: 'EventLog' } },
        { type: 'bsod', timestamp: '2026-03-10T09:30:00.000Z' },
      ],
    })];
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: null });
    expect(values.crashCount30d).toBe(2);
    expect(factors(values.details).crashes!.eventLogSources).toBeUndefined();
  });

  it('treats the agent\'s "unknown" hang placeholder as an unnamed source', () => {
    const rows = [row('2026-03-10T10:00:00.000Z', {
      appHangs: [
        { processName: 'Application Hang', timestamp: '2026-03-10T08:00:00.000Z', duration: 0, resolved: false },
        { processName: 'unknown', timestamp: '2026-03-10T08:30:00.000Z', duration: 0, resolved: false },
      ],
    })];
    const { values } = scoreDeviceReliability({ ...baseInput, rows: rows as any, baseline: null });
    expect(values.hangCount30d).toBe(2);
    expect(factors(values.details).hangs!.eventLogSources).toBeUndefined();
  });

  it('omits the list when the scored events span more sources than a link can carry', () => {
    const crashEvents = Array.from({ length: I.MAX_FACTOR_EVENT_LOG_SOURCES + 1 }, (_, i) => ({
      type: 'bsod', timestamp: `2026-03-10T09:${String(i).padStart(2, '0')}:00.000Z`, details: { source: `Source-${i}` },
    }));
    const { values } = scoreDeviceReliability({ ...baseInput, rows: [row('2026-03-10T10:00:00.000Z', { crashEvents })] as any, baseline: null });
    expect(factors(values.details).crashes!.eventLogSources).toBeUndefined();
  });
});

describe('buildReliabilityDrivers window + sources (#10053)', () => {
  it('passes the persisted window and sources through, outside the numeric evidence', () => {
    const drivers = I.buildReliabilityDrivers({
      factors: {
        crashes: {
          score: 40, weight: 25, crashCount30d: 3,
          windowStart: '2026-03-01T00:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z',
          eventLogSources: ['EventLog', 'Microsoft-Windows-Kernel-Power'],
        },
      },
    }, { computedAt: '2026-03-31T12:00:00.000Z', enrolledAt: null });
    expect(drivers[0]).toMatchObject({
      factor: 'crashes',
      evidence: { crashCount30d: 3 },
      windowStart: '2026-03-01T00:00:00.000Z',
      windowEnd: '2026-03-31T12:00:00.000Z',
      eventLogSources: ['EventLog', 'Microsoft-Windows-Kernel-Power'],
    });
  });

  it('prefers the persisted window over one re-derived from the current enrolment/computedAt', () => {
    const drivers = I.buildReliabilityDrivers({
      factors: {
        crashes: { score: 40, weight: 25, windowStart: '2026-02-20T00:00:00.000Z', windowEnd: '2026-03-21T09:00:00.000Z' },
        hangs: { score: 80, weight: 15, windowStart: '2026-02-20T00:00:00.000Z' },
      },
    }, { computedAt: '2026-03-31T12:00:00.000Z', enrolledAt: '2026-03-05T08:00:00.000Z' });
    expect(drivers.find((d) => d.factor === 'crashes')).toMatchObject({
      windowStart: '2026-02-20T00:00:00.000Z', windowEnd: '2026-03-21T09:00:00.000Z',
    });
    // Half a persisted window is not a window: fall back to the derived one.
    expect(drivers.find((d) => d.factor === 'hangs')).toMatchObject({
      windowStart: '2026-03-05T08:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z',
    });
  });

  it('derives the window server-side for a snapshot scored before windows were persisted', () => {
    const drivers = I.buildReliabilityDrivers({
      factors: {
        hangs: { score: 80, weight: 15, hangCount30d: 2 },
        uptime: { score: 100, weight: 0, uptime90d: 100 },
      },
    }, {
      computedAt: '2026-03-31T12:00:00.000Z',
      enrolledAt: '2026-03-05T08:00:00.000Z',
    });
    const hangs = drivers.find((d) => d.factor === 'hangs')!;
    expect(hangs).toMatchObject({ windowStart: '2026-03-05T08:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z' });
    expect(hangs.eventLogSources).toBeUndefined();
    const uptime = drivers.find((d) => d.factor === 'uptime')!;
    expect(uptime).toMatchObject({ windowStart: '2026-03-05T08:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z' });
  });

  it('clamps a derived window to the snapshot baseline marker', () => {
    const drivers = I.buildReliabilityDrivers({
      factors: { crashes: { score: 100, weight: 25, crashCount30d: 0 } },
      baseline: { id: 'b-1', baselineAt: '2026-03-20T06:00:00.000Z', reason: 'remediated', source: 'manual', reportedDaysSinceBaseline: 11, provisional: true },
    }, { computedAt: '2026-03-31T12:00:00.000Z', enrolledAt: '2025-01-01T00:00:00.000Z' });
    expect(drivers[0]).toMatchObject({ windowStart: '2026-03-20T06:00:00.000Z', windowEnd: '2026-03-31T12:00:00.000Z' });
  });

  it('ignores a malformed persisted source list rather than passing junk to the link', () => {
    const drivers = I.buildReliabilityDrivers({
      factors: { crashes: { score: 40, weight: 25, eventLogSources: ['EventLog', 7, ''] } },
    }, { computedAt: '2026-03-31T12:00:00.000Z' });
    expect(drivers[0]!.eventLogSources).toBeUndefined();
  });
});
