import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartnerGroupMembers, PartnerGroupEvaluationStatus } from './PartnerGroupDetails';
import { fetchWithAuth } from '@/stores/auth';
vi.mock('@/stores/auth', async (importOriginal) => ({ ...await importOriginal<typeof import('@/stores/auth')>(), fetchWithAuth: vi.fn() }));
const mockFetch = vi.mocked(fetchWithAuth);
beforeEach(() => vi.clearAllMocks());

describe('partner group details', () => {
  it('lazily fetches members, reports an error and retries to an empty state', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Temporarily unavailable' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const user = userEvent.setup();
    render(<PartnerGroupMembers groupId="group-1" />);
    expect(mockFetch).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('partner-group-members-toggle-group-1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporarily unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No devices in this group.')).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith('/device-groups/group-1/devices');
    await user.click(screen.getByTestId('partner-group-members-toggle-group-1'));
    await waitFor(() => expect(screen.queryByText('No devices in this group.')).not.toBeInTheDocument());
  });
  it('pluralizes one unevaluated organization and handles missing evaluation time', () => {
    const { rerender } = render(<PartnerGroupEvaluationStatus groupId="g" evaluation={{ state: 'partial', failedOrgs: 1, evaluatedAt: '2026-10-29T12:00:00Z' }} />);
    expect(screen.getByTestId('group-evaluation-g')).toHaveTextContent('1 org not evaluated');
    rerender(<PartnerGroupEvaluationStatus groupId="g" evaluation={{ state: 'current', failedOrgs: 0, evaluatedAt: null }} />);
    expect(screen.getByTestId('group-evaluation-g')).toHaveTextContent('Not evaluated yet');
  });
});
