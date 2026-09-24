import { describe, expect, it } from 'vitest';
import { emptyArAgingSummary, emptyTechnicianTimeSummary, emptyTicketSlaSummary } from './businessReports';

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
