import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ISOLATION_STATES } from '@breeze/shared';
const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
import IsolationBadge from './IsolationBadge';
const episode = { id: 'episode-1', deviceId: 'device-1', incidentId: 'incident-1', state: 'verified' as const, expiresAt: new Date(Date.now() + 6 * 3600000).toISOString() };
beforeEach(() => fetchWithAuth.mockReset());
describe('IsolationBadge', () => {
  it('shows verified isolation and time to expiry', () => {
    render(<IsolationBadge episode={episode} onChange={vi.fn()} />);
    expect(screen.getByTestId('isolation-badge')).toHaveTextContent('Isolated · expires in 6 h');
  });
  it.each([['applying', 'Applying isolation'], ['applied', 'Verifying isolation']] as const)('shows %s honestly', (state, text) => {
    render(<IsolationBadge episode={{ ...episode, state }} onChange={vi.fn()} />);
    expect(screen.getByTestId('isolation-badge')).toHaveTextContent(text);
  });
  it('does not offer extend once release is requested, but keeps the code view', () => {
    render(<IsolationBadge episode={{ ...episode, state: 'release_requested' }} onChange={vi.fn()} />);
    expect(screen.queryByTestId('isolation-extend')).not.toBeInTheDocument();
    expect(screen.getByTestId('isolation-show-code')).toBeInTheDocument();
  });
  it.each(ISOLATION_STATES)('only offers acknowledgement for unresolved terminal state %s', state => {
    render(<IsolationBadge episode={{ ...episode, state }} onChange={vi.fn()} />);
    expect(Boolean(screen.queryByTestId('isolation-acknowledge'))).toBe(['released_locally', 'self_released'].includes(state));
  });
  it('acknowledges through the audited mutation and refreshes', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, status: 200, json: async () => ({ episode }) });
    const onChange = vi.fn();
    render(<IsolationBadge episode={{ ...episode, state: 'released_locally' }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('isolation-acknowledge'));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(fetchWithAuth).toHaveBeenCalledWith('/devices/device-1/network-isolation/episode-1/acknowledge', expect.objectContaining({ method: 'POST' }));
  });
});
