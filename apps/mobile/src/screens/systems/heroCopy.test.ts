import { describe, expect, it } from 'vitest';

import type { Alert } from '../../services/api';
import type { MobileSummary } from '../../services/systems';
import { deriveHeroState } from './heroCopy';

function summary(
  partial: Partial<MobileSummary['devices']> = {},
  alerts: Partial<MobileSummary['alerts']> = {},
): MobileSummary {
  return {
    devices: {
      total: 0,
      online: 0,
      offline: 0,
      maintenance: 0,
      ...partial,
    },
    alerts: {
      total: 0,
      active: 0,
      acknowledged: 0,
      resolved: 0,
      critical: 0,
      ...alerts,
    },
  };
}

function alert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a-1',
    title: 'something',
    message: 'something happened',
    severity: 'medium',
    type: 'system',
    acknowledged: false,
    createdAt: '2026-05-07T00:00:00Z',
    updatedAt: '2026-05-07T00:00:00Z',
    ...overrides,
  };
}

describe('deriveHeroState', () => {
  it('shows the loading ellipsis when summary is null', () => {
    const s = deriveHeroState(null, []);
    expect(s.copy).toBe('…');
    expect(s.segments).toBeNull();
    expect(s.legend).toBeNull();
  });

  it('renders the empty-fleet copy when there are zero devices', () => {
    const s = deriveHeroState(summary({ total: 0 }), []);
    expect(s.copy).toBe('No devices yet.');
    expect(s.segments).toBeNull();
    expect(s.legend).toMatch(/Pair your first device/);
  });

  it('all online + no alerts → "X devices, all healthy."', () => {
    const s = deriveHeroState(summary({ total: 5, online: 5 }), []);
    expect(s.copy).toBe('5 devices, all healthy.');
    expect(s.segments).toEqual({ healthy: 5, warning: 0, critical: 0 });
    expect(s.legend).toBe('5 online');
  });

  it('online + offline + 0 alerts → "X devices · Y offline."', () => {
    const s = deriveHeroState(summary({ total: 5, online: 3, offline: 2 }), []);
    expect(s.copy).toBe('5 devices · 2 offline.');
    expect(s.legend).toBe('3 online · 2 offline');
  });

  it('online + maintenance + 0 alerts → "X devices · Y in maintenance."', () => {
    const s = deriveHeroState(summary({ total: 5, online: 4, maintenance: 1 }), []);
    expect(s.copy).toBe('5 devices · 1 in maintenance.');
    expect(s.legend).toContain('4 online');
    expect(s.legend).toContain('1 maintenance');
  });

  it('1 active issue → "1 issue."', () => {
    const s = deriveHeroState(
      summary({ total: 5, online: 5 }),
      [alert({ id: 'a1', metadata: { orgId: 'org-1' } })],
    );
    expect(s.copy).toBe('1 issue.');
  });

  it('multiple issues, single org → "{n} issues."', () => {
    const s = deriveHeroState(summary({ total: 10, online: 10 }), [
      alert({ id: 'a1', metadata: { orgId: 'org-1' } }),
      alert({ id: 'a2', metadata: { orgId: 'org-1' } }),
      alert({ id: 'a3', metadata: { orgId: 'org-1' } }),
    ]);
    expect(s.copy).toBe('3 issues.');
  });

  it('multiple issues across multiple orgs → "{n} issues across {m} organizations."', () => {
    const s = deriveHeroState(summary({ total: 10, online: 10 }), [
      alert({ id: 'a1', metadata: { orgId: 'org-1' } }),
      alert({ id: 'a2', metadata: { orgId: 'org-2' } }),
      alert({ id: 'a3', metadata: { orgId: 'org-3' } }),
    ]);
    expect(s.copy).toBe('3 issues across 3 organizations.');
  });

  it('segments: when activeIssues is empty + offline > 0, healthy = total - offline, warning = offline, critical = 0', () => {
    const s = deriveHeroState(summary({ total: 10, online: 7, offline: 3 }), []);
    expect(s.segments).toEqual({ healthy: 7, warning: 3, critical: 0 });
  });

  it('segments: critical alerts contribute to the critical slice (not summary.alerts.critical, which can include acked)', () => {
    // Caller supplies summary.alerts.critical = 5 (e.g. acked included), but
    // only 1 unacked critical issue is in activeIssues. The slice must reflect
    // the activeIssues count, not the summary.alerts.critical count.
    const s = deriveHeroState(
      summary({ total: 10, online: 9, offline: 1 }, { critical: 5 }),
      [alert({ id: 'c1', severity: 'critical', metadata: { orgId: 'org-1' } })],
    );
    expect(s.segments?.critical).toBe(1);
    // offline (1) contributes to warning
    expect(s.segments?.warning).toBe(1);
    expect(s.segments?.healthy).toBe(8);
  });

  it('segments: high severity also counts as critical', () => {
    const s = deriveHeroState(summary({ total: 5, online: 5 }), [
      alert({ id: 'h1', severity: 'high', metadata: { orgId: 'org-1' } }),
    ]);
    expect(s.segments?.critical).toBe(1);
  });

  it('segments: medium / low severity counts as warning', () => {
    const s = deriveHeroState(summary({ total: 5, online: 5 }), [
      alert({ id: 'm1', severity: 'medium', metadata: { orgId: 'org-1' } }),
      alert({ id: 'l1', severity: 'low', metadata: { orgId: 'org-1' } }),
    ]);
    expect(s.segments?.warning).toBe(2);
    expect(s.segments?.critical).toBe(0);
  });

  it('alerts without orgId metadata fall back to single-org copy (not "across 0 organizations")', () => {
    const s = deriveHeroState(summary({ total: 4, online: 4 }), [
      alert({ id: 'x1' }),
      alert({ id: 'x2' }),
    ]);
    expect(s.copy).toBe('2 issues.');
  });

  describe('with an org filter active', () => {
    // Regression for #5105: with "Morning Fresh Dairy" filtered, the hero kept
    // reading fleet-wide totals ("77 devices · 23 offline") instead of
    // describing the filtered org. The third argument scopes the hero to one
    // org's own device counts; `activeIssues` is already filtered by the
    // caller (useSystemsData), so no separate issue-filtering is needed here.

    it('describes the org, not the fleet, when all its devices are healthy', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 12, offline: 0, maintenance: 0 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 12 devices, all healthy.');
      expect(s.segments).toEqual({ healthy: 12, warning: 0, critical: 0 });
    });

    it('describes the org offline count, not the fleet-wide one', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 400, offline: 100 }),
        [],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 9, offline: 3, maintenance: 0 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 12 devices · 3 offline.');
    });

    it('describes the org maintenance count when nothing is offline', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 11, offline: 0, maintenance: 1 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 12 devices · 1 in maintenance.');
    });

    it('describes a single org issue as "1 issue.", still prefixed', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [alert({ id: 'a1', metadata: { orgId: 'org-1' } })],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 12, offline: 0, maintenance: 0 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 1 issue.');
    });

    it('describes the org issue count, never "across N organizations" (it is scoped to one)', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [
          alert({ id: 'a1', metadata: { orgId: 'org-1' } }),
          alert({ id: 'a2', metadata: { orgId: 'org-1' } }),
        ],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 12, offline: 0, maintenance: 0 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 2 issues.');
    });

    it('never says "across N organizations" even if the caller failed to filter activeIssues by org', () => {
      // orgScope forces orgCount to 1 regardless of what the alerts' own
      // metadata says — the last line of defense against exactly the #5105
      // defect if useSystemsData's own org filtering ever regresses.
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [
          alert({ id: 'a1', metadata: { orgId: 'org-1' } }),
          alert({ id: 'a2', metadata: { orgId: 'org-2' } }),
        ],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 12, offline: 0, maintenance: 0 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 2 issues.');
    });

    it('reports the org has no devices rather than the fleet-wide empty state, with no onboarding hint', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [],
        { name: 'Morning Fresh Dairy', devices: { total: 0, online: 0, offline: 0, maintenance: 0 } },
      );
      expect(s.copy).toBe('Morning Fresh Dairy: No devices yet.');
      // "Pair your first device..." is fleet-wide onboarding copy — it must
      // not show for an org that simply has no devices of its own.
      expect(s.legend).toBeNull();
    });
  });

  describe('open fleet findings fold into the issue count (#5139)', () => {
    it('a lone open finding, with zero active alerts, still reads as "1 issue."', () => {
      const s = deriveHeroState(summary({ total: 5, online: 5 }), [], null, 1);
      expect(s.copy).toBe('1 issue.');
    });

    it('findings add to the active-alert count rather than replacing it', () => {
      const s = deriveHeroState(
        summary({ total: 10, online: 10 }),
        [alert({ id: 'a1', metadata: { orgId: 'org-1' } })],
        null,
        2,
      );
      expect(s.copy).toBe('3 issues.');
    });

    it('defaults to 0 findings when the argument is omitted (back-compat with existing callers)', () => {
      const s = deriveHeroState(summary({ total: 5, online: 5 }), []);
      expect(s.copy).toBe('5 devices, all healthy.');
    });

    it('zero findings and zero alerts still reads "all healthy"', () => {
      const s = deriveHeroState(summary({ total: 5, online: 5 }), [], null, 0);
      expect(s.copy).toBe('5 devices, all healthy.');
    });

    it('org-scoped hero folds in that org\'s own findings count', () => {
      const s = deriveHeroState(
        summary({ total: 500, online: 500 }),
        [],
        { name: 'Morning Fresh Dairy', devices: { total: 12, online: 12, offline: 0, maintenance: 0 } },
        1,
      );
      expect(s.copy).toBe('Morning Fresh Dairy: 1 issue.');
    });

    it('a findings-only spread across multiple orgs still says "across N organizations" (no active alerts to derive it from)', () => {
      // Regression: orgCount used to be derived from activeIssues alone, so a
      // fleet with 0 active alerts but 3 open findings spread across 3 orgs
      // rendered "3 issues." instead of "3 issues across 3 organizations." —
      // the copy ladder's "across N organizations" promise silently broke for
      // a findings-only fleet.
      const s = deriveHeroState(
        summary({ total: 10, online: 10 }),
        [],
        null,
        3,
        ['org-1', 'org-2', 'org-3'],
      );
      expect(s.copy).toBe('3 issues across 3 organizations.');
    });

    it('merges alert orgs and findings orgs into one unique count, not a sum', () => {
      const s = deriveHeroState(
        summary({ total: 10, online: 10 }),
        [alert({ id: 'a1', metadata: { orgId: 'org-1' } })],
        null,
        1,
        ['org-1'], // same org as the alert — must not double-count to 2 orgs
      );
      // orgCount resolves to 1 (both issues are in org-1), so the copy ladder
      // takes the single-org branch, not "across N organizations."
      expect(s.copy).toBe('2 issues.');
    });
  });
});
