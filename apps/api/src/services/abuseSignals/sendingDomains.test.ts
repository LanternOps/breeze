import { describe, expect, it, vi } from 'vitest';
import { loadSignalConfig } from './config';
import {
  computeSendingDomainSignals, loadSendingDomainAggregates, type SendingDomainAggregate,
} from './sendingDomains';

const { executeMock, capHitWindowMock } = vi.hoisted(() => ({
  executeMock: vi.fn(async () => ({ rows: [] as unknown[] })),
  capHitWindowMock: vi.fn(async () => new Map<string, number>()),
}));
vi.mock('../../db', () => ({ db: { execute: executeMock } }));
vi.mock('../emailDomains/capHits', () => ({ CAP_HIT_WINDOW_DAYS: 7, loadCapHitWindow: capHitWindowMock }));

const cfg = loadSignalConfig();

function agg(over: Partial<SendingDomainAggregate> = {}): SendingDomainAggregate {
  return {
    partnerId: 'p1',
    partnerName: 'Acme MSP',
    recentDomains: [],
    failedVerifications: [],
    capHits: 0,
    windowSent: 0, windowDelivered: 0, windowBounced: 0,
    windowComplained: 0, windowFailed: 0,
    windowMessages: 0, windowBounceRate: 0,
    ...over,
  };
}

function keys(signals: ReturnType<typeof computeSendingDomainSignals>): string[] {
  return signals.map((s) => s.signalKey).sort();
}

describe('computeSendingDomainSignals — nothing to say', () => {
  it('emits nothing for a partner with no sending activity at all', () => {
    expect(computeSendingDomainSignals([agg()], cfg)).toEqual([]);
  });
});

describe('email.sending_domain_added', () => {
  it('fires at info severity and carries the domain NAME for lookalike review', () => {
    const signals = computeSendingDomainSignals([agg({
      recentDomains: [{ domain: 'acrne-bank.test', createdAt: new Date('2026-09-16T00:00:00Z') }],
    })], cfg);
    expect(keys(signals)).toEqual(['email.sending_domain_added']);
    expect(signals[0]!.severity).toBe('info');
    expect(signals[0]!.evidence.domains).toEqual(['acrne-bank.test']);
    expect(signals[0]!.evidence.partnerName).toBe('Acme MSP');
  });

  it('caps the evidence list so one partner cannot flood an alert body', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ domain: `d${i}.test`, createdAt: new Date() }));
    const signals = computeSendingDomainSignals([agg({ recentDomains: many })], cfg);
    expect((signals[0]!.evidence.domains as string[]).length).toBeLessThanOrEqual(10);
    expect(signals[0]!.evidence.addedCount).toBe(40);
  });
});

describe('email.sending_domain_verify_failures', () => {
  it('does not fire below the configured minimum', () => {
    const signals = computeSendingDomainSignals([agg({
      failedVerifications: [{ domain: 'a.test', checkAttempts: 4, statusReason: 'dns_not_detected' }],
    })], cfg);
    expect(keys(signals)).not.toContain('email.sending_domain_verify_failures');
  });

  it('fires at watch severity at exactly the minimum', () => {
    const failed = Array.from({ length: cfg['email.sending_domain_verify_failures.min_domains'] }, (_, i) => ({
      domain: `f${i}.test`, checkAttempts: 9, statusReason: 'dns_not_detected',
    }));
    const signals = computeSendingDomainSignals([agg({ failedVerifications: failed })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_domain_verify_failures');
    expect(signal).toBeDefined();
    expect(signal!.severity).toBe('watch');
    expect(signal!.evidence.failedDomains).toEqual(failed.map((f) => f.domain).slice(0, 10));
  });
});

describe('email.partner_lane_cap_hit', () => {
  it('does not fire below the configured minimum hits', () => {
    const signals = computeSendingDomainSignals([agg({ capHits: 1 })], cfg);
    expect(keys(signals)).not.toContain('email.partner_lane_cap_hit');
  });

  it('fires at watch severity at exactly the minimum hits', () => {
    const signals = computeSendingDomainSignals([
      agg({ capHits: cfg['email.partner_lane_cap_hit.min_hits'] }),
    ], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.partner_lane_cap_hit');
    expect(signal!.severity).toBe('watch');
    expect(signal!.evidence.capHits).toBe(cfg['email.partner_lane_cap_hit.min_hits']);
  });
});

describe('email.sending_bounce_complaint', () => {
  it('fires on a bounce rate over the threshold with enough messages', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 500, windowDelivered: 440, windowBounced: 55, windowFailed: 5,
      windowMessages: 500, windowBounceRate: 0.11,
    })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_bounce_complaint');
    expect(signal).toBeDefined();
    expect(signal!.evidence.bounceRate).toBeCloseTo(0.11, 5);
  });

  it('does not fire on a high rate over too few messages', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 10, windowDelivered: 5, windowBounced: 5,
      windowMessages: 10, windowBounceRate: 0.5,
    })], cfg);
    expect(keys(signals)).not.toContain('email.sending_bounce_complaint');
  });

  it('fires on complaints alone, whatever the volume', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 4, windowDelivered: 4, windowComplained: cfg['email.sending_bounce_complaint.min_complaints'],
      windowMessages: 4,
    })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_bounce_complaint');
    expect(signal!.evidence.complained).toBe(cfg['email.sending_bounce_complaint.min_complaints']);
  });

  // Auto-suspension already paged for exactly these facts (spec §9.3). A second
  // page for the same partner is noise, so this stays below the alert score.
  it('stays at watch severity — it must never page on its own', () => {
    const signals = computeSendingDomainSignals([agg({
      windowSent: 5000, windowBounced: 4000, windowComplained: 900,
      windowMessages: 5000, windowBounceRate: 0.8,
    })], cfg);
    const signal = signals.find((s) => s.signalKey === 'email.sending_bounce_complaint');
    expect(signal!.severity).toBe('watch');
    expect(signal!.score).toBeLessThan(cfg['severity.alert_score']);
  });
});

describe('every emitted signal is well-formed', () => {
  it('carries partnerName in evidence — index.ts formatSignalAlert reads it', () => {
    const signals = computeSendingDomainSignals([agg({
      recentDomains: [{ domain: 'x.test', createdAt: new Date() }],
      capHits: 99,
      windowSent: 500, windowBounced: 100, windowMessages: 500, windowBounceRate: 0.2,
      failedVerifications: Array.from({ length: 5 }, (_, i) => ({ domain: `f${i}.test`, checkAttempts: 9, statusReason: 'dns_not_detected' })),
    })], cfg);
    expect(signals).toHaveLength(4);
    for (const signal of signals) {
      expect(signal.partnerId).toBe('p1');
      expect(signal.evidence.partnerName).toBe('Acme MSP');
      expect(signal.signalKey.length).toBeLessThanOrEqual(64);
      expect(signal.score).toBeGreaterThan(0);
      expect(signal.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('loadSendingDomainAggregates — the window boundary', () => {
  // `current_date` is evaluated in the SESSION time zone. A connection running
  // anywhere east of UTC rolls over hours early and would silently shift the
  // 7-day window by a day against deliveryStats, which keys its rows on the UTC
  // calendar day. The bound value has to be computed in UTC, in JS.
  it('binds a UTC window start rather than leaning on the server time zone', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    // 23:45Z is already the NEXT day in any zone at or east of UTC+1.
    await loadSendingDomainAggregates(new Date('2026-09-17T23:45:00.000Z'));
    const serialized = JSON.stringify(executeMock.mock.calls[0]![0]);
    expect(serialized).toContain('2026-09-11');
    expect(serialized).not.toContain('current_date');
  });
});
