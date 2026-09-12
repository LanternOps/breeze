import { describe, expect, it } from 'vitest';

import { deriveFleetBarSegments } from './fleetBarSegments';
import { deriveHeroState } from '../screens/systems/heroCopy';
import { deriveStripFleetSegments } from '../screens/chat/components/homeFleetStripCopy';
import type { Alert } from '../services/api';
import type { MobileSummary } from '../services/systems';

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a-1',
    title: 'something',
    message: 'something happened',
    severity: 'medium',
    type: 'system',
    acknowledged: false,
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
    ...overrides,
  };
}

function summary(
  devices: Partial<MobileSummary['devices']> = {},
  alerts: Partial<MobileSummary['alerts']> = {},
): MobileSummary {
  return {
    devices: { total: 0, online: 0, offline: 0, maintenance: 0, ...devices },
    alerts: { total: 0, active: 0, acknowledged: 0, resolved: 0, critical: 0, ...alerts },
  };
}

describe('deriveFleetBarSegments', () => {
  it('paints offline and maintenance devices as warning, never critical', () => {
    expect(
      deriveFleetBarSegments({
        total: 50,
        offline: 15,
        maintenance: 1,
        criticalAlerts: 0,
        warningAlerts: 0,
      }),
    ).toEqual({ healthy: 34, warning: 16, critical: 0 });
  });

  it('reserves the critical slice for critical/high alerts', () => {
    expect(
      deriveFleetBarSegments({
        total: 10,
        offline: 2,
        maintenance: 0,
        criticalAlerts: 3,
        warningAlerts: 1,
      }),
    ).toEqual({ healthy: 4, warning: 3, critical: 3 });
  });

  it('clamps a critical count larger than the fleet to the whole bar', () => {
    expect(
      deriveFleetBarSegments({
        total: 4,
        offline: 0,
        maintenance: 0,
        criticalAlerts: 9,
        warningAlerts: 2,
      }),
    ).toEqual({ healthy: 0, warning: 0, critical: 4 });
  });

  it('clamps the warning slice to what the critical slice left over', () => {
    expect(
      deriveFleetBarSegments({
        total: 6,
        offline: 5,
        maintenance: 4,
        criticalAlerts: 2,
        warningAlerts: 0,
      }),
    ).toEqual({ healthy: 0, warning: 4, critical: 2 });
  });

  it('returns an all-zero bar for an empty fleet', () => {
    expect(
      deriveFleetBarSegments({
        total: 0,
        offline: 0,
        maintenance: 0,
        criticalAlerts: 0,
        warningAlerts: 0,
      }),
    ).toEqual({ healthy: 0, warning: 0, critical: 0 });
  });
});

// The regression this file exists for (#5364): Home painted offline devices
// red while Systems painted the same devices amber. Both surfaces now feed the
// one mapping above, so the same fleet must produce the same bar on both.
describe('hero and Home strip agree on the same fleet', () => {
  const devices = { total: 50, online: 34, offline: 15, maintenance: 1 };

  it('produces identical segments for the same fleet state', () => {
    const activeIssues = [
      alert({ id: 'a-1', severity: 'medium' }),
      alert({ id: 'a-2', severity: 'low' }),
    ];
    const hero = deriveHeroState(
      summary(devices, { active: activeIssues.length }),
      activeIssues,
      null,
      3,
      [],
    );
    const strip = deriveStripFleetSegments(summary(devices, { active: activeIssues.length }));

    expect(strip).toEqual(hero.segments);
    // Offline devices are amber on BOTH surfaces, not red on one of them.
    expect(strip).toEqual({ healthy: 32, warning: 18, critical: 0 });
  });

  it('agrees on an all-healthy fleet', () => {
    const healthy = { total: 12, online: 12, offline: 0, maintenance: 0 };
    const hero = deriveHeroState(summary(healthy), [], null, 0, []);
    const strip = deriveStripFleetSegments(summary(healthy));

    expect(strip).toEqual(hero.segments);
    expect(strip).toEqual({ healthy: 12, warning: 0, critical: 0 });
  });
});
