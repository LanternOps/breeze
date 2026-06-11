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
});
