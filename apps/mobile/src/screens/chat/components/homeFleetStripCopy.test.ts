import { describe, expect, it } from 'vitest';

import type { MobileSummary } from '../../../services/systems';
import { formatFleetStripCopy } from './homeFleetStripCopy';

function summary(
  devices: Partial<MobileSummary['devices']> = {},
  alerts: Partial<MobileSummary['alerts']> = {},
): MobileSummary {
  return {
    devices: { total: 0, online: 0, offline: 0, maintenance: 0, ...devices },
    alerts: { total: 0, active: 0, acknowledged: 0, resolved: 0, critical: 0, ...alerts },
  };
}

describe('formatFleetStripCopy', () => {
  it('formats plural counts', () => {
    expect(formatFleetStripCopy(summary({ online: 34, offline: 23 }, { active: 2 }))).toBe(
      '34 online · 23 offline · 2 issues',
    );
  });

  it('singularizes exactly one issue', () => {
    expect(formatFleetStripCopy(summary({ online: 1, offline: 0 }, { active: 1 }))).toBe(
      '1 online · 0 offline · 1 issue',
    );
  });

  it('collapses zero issues to "no issues"', () => {
    expect(formatFleetStripCopy(summary({ online: 10, offline: 0 }, { active: 0 }))).toBe(
      '10 online · 0 offline · no issues',
    );
  });

  it('does not pluralize online/offline counts (they have no unit word)', () => {
    expect(formatFleetStripCopy(summary({ online: 1, offline: 1 }, { active: 0 }))).toBe(
      '1 online · 1 offline · no issues',
    );
  });
});
