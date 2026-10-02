import { describe, expect, it } from 'vitest';
import { emptyAiUsageByClientSummary, emptyArAgingSummary, emptyTechnicianTimeSummary, emptyTicketSlaSummary } from './businessReports';

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
