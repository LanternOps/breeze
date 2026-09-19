import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';

const state = vi.hoisted(() => ({ denied: false, setPageContext: vi.fn(), devices: { total: 3 }, summary: { byStatus: { active: 2 } } }));
vi.mock('../../stores/auth', () => ({ useAuthStore: () => ({ user: { name: 'Test' } }) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: (fn: any) => fn({ currentOrgId: 'org' }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: { getState: () => ({ setPageContext: state.setPageContext }) } }));
vi.mock('../../hooks/useDashboardQuery', () => ({ useDashboardQuery: (path: string) => ({
  data: path === '/devices/stats' ? state.devices : path === '/alerts/summary' && !state.denied ? state.summary : null,
  unavailable: path !== '/devices/stats', isLoading: false, isFetching: false, error: null,
}) }));
vi.mock('./KpiStrip', () => ({ default: () => null }));
vi.mock('./AlertsFeed', () => ({ default: () => null }));
vi.mock('./FleetStatusCard', () => ({ default: () => null }));
vi.mock('./SecurityPostureCard', () => ({ default: () => null }));
vi.mock('./PatchComplianceCard', () => ({ default: () => null }));
vi.mock('./VulnerabilitiesCard', () => ({ default: () => null }));
vi.mock('./RecentActivity', () => ({ default: () => null }));

describe('dashboard alert context revocation', () => {
  it('removes the previous alert count when the summary becomes unavailable', async () => {
    const { rerender } = render(<DashboardPage />);
    await waitFor(() => expect(state.setPageContext).toHaveBeenLastCalledWith({ type: 'dashboard', deviceCount: 3, alertCount: 2 }));
    state.denied = true;
    rerender(<DashboardPage />);
    await waitFor(() => expect(state.setPageContext).toHaveBeenLastCalledWith({ type: 'dashboard', deviceCount: 3 }));
  });
});
