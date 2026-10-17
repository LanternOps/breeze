import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DashboardPage from './DashboardPage';
import { useRecentsStore } from '../../stores/recentsStore';

vi.mock('../../stores/auth', () => ({ useAuthStore: () => ({ user: { name: 'Test' } }) }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: (fn: any) => fn({ currentOrgId: 'org' }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: { getState: () => ({ setPageContext: vi.fn() }) } }));
vi.mock('../../hooks/useDashboardQuery', () => ({
  useDashboardQuery: () => ({ data: null, unavailable: true, isLoading: false, isFetching: false, error: null }),
}));
vi.mock('./KpiStrip', () => ({ default: () => null }));
vi.mock('./AlertsFeed', () => ({ default: () => null }));
vi.mock('./FleetStatusCard', () => ({ default: () => null }));
vi.mock('./SecurityPostureCard', () => ({ default: () => null }));
vi.mock('./PatchComplianceCard', () => ({ default: () => null }));
vi.mock('./VulnerabilitiesCard', () => ({ default: () => null }));
vi.mock('./RecentActivity', () => ({ default: () => <div data-testid="recent-activity-stub" /> }));

function seedDevices(n: number) {
  const s = useRecentsStore.getState();
  s.hydrate('u1');
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(Date.now() + 1000);
    s.recordDevice({ id: `d${i}`, name: `host-${i}` });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  localStorage.clear();
  useRecentsStore.getState().hydrate(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DashboardPage — recently viewed card', () => {
  it('hides the card and keeps Recent activity full width when nothing was opened', async () => {
    render(<DashboardPage />);
    const stub = await screen.findByTestId('recent-activity-stub');
    expect(screen.queryByTestId('dashboard-recently-viewed')).toBeNull();
    expect(stub.parentElement!.className).not.toContain('lg:col-span-2');
  });

  it('shows the top 8 entries beside Recent activity', async () => {
    seedDevices(9);
    render(<DashboardPage />);
    const card = await screen.findByTestId('dashboard-recently-viewed');
    expect(screen.getAllByTestId('dashboard-recently-viewed-link')).toHaveLength(8);
    const row = screen.getByTestId('recent-activity-stub').parentElement!.parentElement!;
    expect(row).toBe(card.parentElement);
    expect(row.className).toContain('lg:grid-cols-3');
  });

  it('renders no card on the server pass even with a populated store', () => {
    seedDevices(2);
    expect(renderToString(<DashboardPage />)).not.toContain('dashboard-recently-viewed');
  });
});
