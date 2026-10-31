import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';

// #10295: the dashboard must not fire GET /audit-logs/logs for a role without
// audit:read (e.g. Partner Viewer) — it 403s and logs a red console line.

const state = vi.hoisted(() => ({
  permissions: undefined as Array<{ resource: string; action: string }> | undefined,
  calls: [] as Array<{ path: string; options?: { enabled?: boolean } }>,
}));

vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({ user: { name: 'Test', permissions: state.permissions } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: (fn: any) => fn({ currentOrgId: 'org' }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: { getState: () => ({ setPageContext: vi.fn() }) } }));
vi.mock('../../hooks/useDashboardQuery', () => ({
  useDashboardQuery: (path: string, _tick: number, _select: unknown, options?: { enabled?: boolean }) => {
    state.calls.push({ path, options });
    return { data: null, unavailable: true, isLoading: false, isFetching: false, error: null };
  },
}));
vi.mock('./KpiStrip', () => ({ default: () => null }));
vi.mock('./AlertsFeed', () => ({ default: () => null }));
vi.mock('./FleetStatusCard', () => ({ default: () => null }));
vi.mock('./SecurityPostureCard', () => ({ default: () => null }));
vi.mock('./PatchComplianceCard', () => ({ default: () => null }));
vi.mock('./VulnerabilitiesCard', () => ({ default: () => null }));
vi.mock('./RecentActivity', () => ({ default: () => null }));

function auditSlotEnabled(): boolean | undefined {
  const call = [...state.calls].reverse().find((c) => c.path.startsWith('/audit-logs/logs'));
  expect(call).toBeDefined();
  return call?.options?.enabled;
}

beforeEach(() => {
  state.calls = [];
  state.permissions = undefined;
});

describe('DashboardPage permission gates (#10295)', () => {
  it('disables the recent-activity slot for a role without audit:read', () => {
    state.permissions = [
      { resource: 'devices', action: 'read' },
      { resource: 'organizations', action: 'read' },
    ];
    render(<DashboardPage />);
    expect(auditSlotEnabled()).toBe(false);
  });

  it('disables the slot while permissions are still loading', () => {
    render(<DashboardPage />);
    expect(auditSlotEnabled()).toBe(false);
  });

  it('enables the slot for audit:read and for the *:* admin grant', () => {
    state.permissions = [{ resource: 'audit', action: 'read' }];
    const { unmount } = render(<DashboardPage />);
    expect(auditSlotEnabled()).toBe(true);
    unmount();

    state.permissions = [{ resource: '*', action: '*' }];
    render(<DashboardPage />);
    expect(auditSlotEnabled()).toBe(true);
  });

  it('leaves the other slots ungated', () => {
    render(<DashboardPage />);
    const gated = state.calls.filter((c) => c.options !== undefined).map((c) => c.path);
    expect(gated.every((p) => p.startsWith('/audit-logs/logs'))).toBe(true);
  });
});
