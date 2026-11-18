import { describe, expect, it } from 'vitest';
import { emptyAiUsageByClientSummary, emptyArAgingSummary, emptyTechnicianTimeSummary, emptyTicketSlaSummary, emptyMrrRenewalsSummary, emptyQuoteWinRateSummary, emptyClientProfitabilitySummary, CLIENT_PROFITABILITY_REVENUE_CATEGORIES } from './businessReports';

const NOTE = 'nothing was queried';

describe('empty business summaries', () => {
  it('carry the note and NEVER report an unmeasured ratio as zero', () => {
    const sla = emptyTicketSlaSummary(NOTE);
    expect(sla.notes).toContain(NOTE);
    expect(sla.overall.responseAttainment).toBeNull();
    expect(sla.overall.resolutionAttainment).toBeNull();
    expect(sla.groups).toEqual([]);

    const time = emptyTechnicianTimeSummary(NOTE);
    expect(time.overall.utilization).toBeNull();
    expect(time.overall.billingConversion).toBeNull();
    expect(time.overall.billableValue).toEqual([]);

    const ar = emptyArAgingSummary(NOTE);
    expect(ar.byCurrency).toEqual([]);
    expect(ar.otherOpenBalance).toEqual([]);
  });

  it('report an untruncated, zero-row detail block', () => {
    for (const s of [emptyTicketSlaSummary(NOTE), emptyTechnicianTimeSummary(NOTE), emptyArAgingSummary(NOTE)]) {
      expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
      expect(s.rows).toEqual([]);
    }
  });

  it('the AR empty summary asOf is a YYYY-MM-DD date, never a full timestamp', () => {
    expect(emptyArAgingSummary(NOTE).asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('emptyAiUsageByClientSummary', () => {
  it('carries the note, reports zero requests and an untruncated empty detail block', () => {
    const s = emptyAiUsageByClientSummary(NOTE);
    expect(s.notes).toEqual([NOTE]);
    expect(s.groups).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.overall.requests).toBe(0);
    expect(s.overall.costUsd).toBe('0.00');
    expect(s.overall.includedCostUsd).toBe('0.00');
    expect(s.overall.unpricedRequests).toBe(0);
    expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
  });

  it('has no chargeable amount at all: an empty report prints no money, not a zero per currency', () => {
    expect(emptyAiUsageByClientSummary(NOTE).overall.charges).toEqual([]);
  });

  it('defaults to the organization axis and an empty UTC period', () => {
    const s = emptyAiUsageByClientSummary(NOTE);
    expect(s.groupBy).toBe('organization');
    expect(s.period).toMatchObject({ timeZone: 'UTC' });
    expect(s.scope).toEqual({ kind: 'organization', orgId: '', orgName: null });
  });
});

describe('emptyMrrRenewalsSummary (#9828 W1)', () => {
  it('carries the note, an untruncated empty detail block and no money at all', () => {
    const s = emptyMrrRenewalsSummary(NOTE);
    expect(s.measured).toBe(false);
    expect(s.notes).toEqual([NOTE]);
    expect(s.byCurrency).toEqual([]);
    expect(s.groups).toEqual([]);
    expect(s.renewals).toEqual({ totals: [], contractIds: [] });
    expect(s.activeNotInTerm).toEqual([]);
    expect(s.skipped).toEqual([]);
    expect(s.billedRecurring).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
  });

  it('defaults to the organization axis, a 90-day horizon and a UTC calendar-date asOf', () => {
    const s = emptyMrrRenewalsSummary(NOTE);
    expect(s.groupBy).toBe('organization');
    expect(s.renewalHorizonDays).toBe(90);
    expect(s.timeZone).toBe('UTC');
    expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(s.scope).toEqual({ kind: 'organization', orgId: '', orgName: null });
  });
});

describe('emptyQuoteWinRateSummary (#9828 W2)', () => {
  it('carries the note, an untruncated empty detail block and no money at all', () => {
    const s = emptyQuoteWinRateSummary(NOTE);
    expect(s.notes).toEqual([NOTE]);
    expect(s.groups).toEqual([]);
    expect(s.rows).toEqual([]);
    expect(s.overall.money).toEqual([]);
    expect(s.diagnostics).toEqual({ unreachable: 0, depthCapped: 0 });
    expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
  });

  it('NEVER reports an unmeasured rate as zero: every rate and median is null', () => {
    const o = emptyQuoteWinRateSummary(NOTE).overall;
    expect(o).toMatchObject({
      lineages: 0, won: 0, lost: 0, expired: 0, open: 0, anomalies: 0, viewed: 0,
      winRate: null, closeRate: null, viewedRate: null, medianDaysToWin: null, medianDaysToLoss: null,
    });
  });

  it('defaults to the organization axis and an empty UTC period', () => {
    const s = emptyQuoteWinRateSummary(NOTE);
    expect(s.groupBy).toBe('organization');
    expect(s.period).toMatchObject({ timeZone: 'UTC' });
    expect(s.scope).toEqual({ kind: 'organization', orgId: '', orgName: null });
  });
});

describe('emptyClientProfitabilitySummary (#9828 W3)', () => {
  it('carries the note, an untruncated empty detail block, no money, no hours and no labor rate', () => {
    const s = emptyClientProfitabilitySummary(NOTE);
    expect(s.notes).toEqual([NOTE]);
    expect(s.byCurrency).toEqual([]);
    expect(s.orgs).toEqual([]);
    expect(s.sources).toEqual([]);
    expect(s.unattributedHours).toBeNull();
    expect(s.laborCostPerHour).toBeNull();
    expect(s.rows).toEqual([]);
    expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
    expect(s.groupBy).toBe('organization');
    expect(s.scope).toEqual({ kind: 'organization', orgId: '', orgName: null });
  });

  it('names the five revenue categories in mix order', () => {
    expect([...CLIENT_PROFITABILITY_REVENUE_CATEGORIES]).toEqual(['recurring', 'labor', 'product', 'ai', 'other']);
  });
});
