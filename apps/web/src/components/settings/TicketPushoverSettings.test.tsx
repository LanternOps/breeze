import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TicketPushoverSettings from './TicketPushoverSettings';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const KEY = 'u'.repeat(30);

beforeEach(() => {
  mocks.fetchWithAuth.mockReset();
});

describe('TicketPushoverSettings', () => {
  it('shows whether a key is set without ever receiving the key', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(ok({ userKeySet: true }));
    render(<TicketPushoverSettings />);
    await waitFor(() => expect(screen.getByTestId('ticket-pushover-status').textContent).not.toBe(''));
    expect(screen.getByTestId('ticket-pushover-remove')).toBeTruthy();
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/users/me/ticket-pushover');
  });

  it('rejects a malformed key without calling the API, then saves a valid one with PUT', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(ok({ userKeySet: false }));
    render(<TicketPushoverSettings />);
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1));

    await userEvent.type(screen.getByTestId('ticket-pushover-key'), 'short');
    await userEvent.click(screen.getByTestId('ticket-pushover-save'));
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(1);

    mocks.fetchWithAuth.mockResolvedValueOnce(ok({ userKeySet: true }));
    await userEvent.clear(screen.getByTestId('ticket-pushover-key'));
    await userEvent.type(screen.getByTestId('ticket-pushover-key'), KEY);
    await userEvent.click(screen.getByTestId('ticket-pushover-save'));
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2));
    const [path, init] = mocks.fetchWithAuth.mock.calls[1]!;
    expect(path).toBe('/users/me/ticket-pushover');
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify({ userKey: KEY }) });
    expect((screen.getByTestId('ticket-pushover-key') as HTMLInputElement).value).toBe('');
  });

  it('removes the key with DELETE', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(ok({ userKeySet: true }));
    render(<TicketPushoverSettings />);
    await waitFor(() => expect(screen.getByTestId('ticket-pushover-remove')).toBeTruthy());
    mocks.fetchWithAuth.mockResolvedValueOnce(ok({ userKeySet: false }));
    await userEvent.click(screen.getByTestId('ticket-pushover-remove'));
    await waitFor(() => expect(mocks.fetchWithAuth.mock.calls[1]![1]).toMatchObject({ method: 'DELETE' }));
  });
});
