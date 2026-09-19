import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FleetOrchestrationPage from './FleetOrchestrationPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/hooks/useOrgScope', () => ({ getOrgScope: () => ({ scope: 'all' }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: { getState: () => ({ setPageContext: vi.fn() }) } }));
vi.mock('./FindingsFeed', () => ({ default: () => <div>Findings</div> }));
vi.mock('./FixPickerModal', () => ({ default: () => null }));
vi.mock('./RunProgressPanel', () => ({ default: () => null }));

beforeEach(() => { vi.clearAllMocks(); });

describe('fleet alert summary availability', () => {
  it.each([200, 403])('renders the actual summary or unavailable for HTTP %s', async (status) => {
    vi.mocked(fetchWithAuth).mockImplementation(async (path) => new Response(JSON.stringify(
      String(path) === '/alerts/summary'
        ? status === 200 ? { total: 3, bySeverity: { critical: 1 } } : { error: 'Permission denied' }
        : { data: [] }
    ), { status: String(path) === '/alerts/summary' ? status : 200 }));
    render(<FleetOrchestrationPage />);
    await waitFor(() => expect(screen.queryByTestId('fleet-stats-loading')).not.toBeInTheDocument());
    const chip = screen.getByTestId('fleet-stat-alerts');
    expect(within(chip).getByText(status === 200 ? '3' : '—')).toBeInTheDocument();
    expect(within(chip).queryByText('0')).not.toBeInTheDocument();
  });
});
