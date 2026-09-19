import { describe, expect, it } from 'vitest';

import type { MobileSummary } from '../../../services/systems';
import { deriveStripFleetSegments, formatFleetStripCopy } from './homeFleetStripCopy';

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

  it('shows a zero online count plainly rather than collapsing it like issues', () => {
    expect(formatFleetStripCopy(summary({ online: 0, offline: 5 }, { active: 0 }))).toBe(
      '0 online · 5 offline · no issues',
    );
  });

  // #5364: the strip counted alerts only while the Systems hero counted
  // alerts + open fleet findings, so the same fleet read "no issues" on Home
  // and "3 issues across 3 organizations" one tab over.
  it('counts open fleet findings even when no alerts are active', () => {
    expect(formatFleetStripCopy(summary({ online: 36, offline: 15 }, { active: 0 }), 3)).toBe(
      '36 online · 15 offline · 3 issues',
    );
  });

  it('adds findings to active alerts rather than replacing them', () => {
    expect(formatFleetStripCopy(summary({ online: 36, offline: 15 }, { active: 2 }), 3)).toBe(
      '36 online · 15 offline · 5 issues',
    );
  });

  it('singularizes a lone finding', () => {
    expect(formatFleetStripCopy(summary({ online: 4, offline: 0 }, { active: 0 }), 1)).toBe(
      '4 online · 0 offline · 1 issue',
    );
  });

  it('still says "no issues" with zero alerts and zero findings', () => {
    expect(formatFleetStripCopy(summary({ online: 36, offline: 15 }, { active: 0 }), 0)).toBe(
      '36 online · 15 offline · no issues',
    );
  });

  // A failed findings fetch degrades to 0 rather than hiding the strip
  // (#5177), which is the same thing as omitting the argument entirely.
  it('treats an omitted findings count as zero', () => {
    expect(formatFleetStripCopy(summary({ online: 36, offline: 15 }, { active: 2 }))).toBe(
      '36 online · 15 offline · 2 issues',
    );
  });
});

describe('deriveStripFleetSegments', () => {
  it('paints offline devices amber, matching the Systems hero (#5364)', () => {
    expect(
      deriveStripFleetSegments(
        summary({ total: 51, online: 36, offline: 15 }, { active: 0 }),
      ),
    ).toEqual({ healthy: 36, warning: 15, critical: 0 });
  });

  it('folds active alerts into the warning slice', () => {
    expect(
      deriveStripFleetSegments(
        summary({ total: 10, online: 10, offline: 0, maintenance: 0 }, { active: 2 }),
      ),
    ).toEqual({ healthy: 8, warning: 2, critical: 0 });
  });
});
