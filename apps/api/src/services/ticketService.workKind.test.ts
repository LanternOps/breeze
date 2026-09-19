import { describe, expect, it } from 'vitest';
import { resolveSlaTargetsForWorkKind } from './ticketService';

describe('SLA defaults by work kind (#5573 spec §4.8, D3)', () => {
  const targets = { responseMinutes: 60, resolutionMinutes: 480 };

  it('keeps the resolved SLA for support work', () => {
    expect(resolveSlaTargetsForWorkKind('support', targets)).toEqual(targets);
  });

  it('drops BOTH SLA minutes for deliverable work', () => {
    // The SLA worker clocks from created_at, so a 7-day-lead deliverable ticket
    // would breach before the work was due.
    expect(resolveSlaTargetsForWorkKind('deliverable', targets)).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });

  it('drops both for the reserved project_task kind too', () => {
    expect(resolveSlaTargetsForWorkKind('project_task', targets)).toEqual({ responseMinutes: null, resolutionMinutes: null });
  });
});
