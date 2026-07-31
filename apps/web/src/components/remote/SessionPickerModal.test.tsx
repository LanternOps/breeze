import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SessionPickerModal from './SessionPickerModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const SESSIONS = {
  data: {
    deviceId: 'dev-1',
    sessions: [
      { sessionId: 1, username: 'console-user', state: 'active', type: 'console', helperConnected: false, idleMinutes: 2 },
      { sessionId: 3, username: 'alice', state: 'active', type: 'rdp', helperConnected: true, idleMinutes: null },
      { sessionId: 5, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false, idleMinutes: 480 },
    ],
  },
};

describe('SessionPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(SESSIONS));
  });

  it('lists live sessions and disables disconnected rows for desktop', async () => {
    const onSelect = vi.fn();
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="desktop" onSelect={onSelect} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('session-picker-row-3')).toBeDefined());
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/sessions/live');

    expect((screen.getByTestId('session-picker-row-5') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('session-picker-row-5'));
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('session-picker-row-3'));
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('keeps disconnected rows selectable for scripts', async () => {
    const onSelect = vi.fn();
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="script" onSelect={onSelect} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('session-picker-row-5')).toBeDefined());
    fireEvent.click(screen.getByTestId('session-picker-row-5'));
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  it('shows the error state when the probe fails', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'agent offline' }, false, 502));
    render(<SessionPickerModal isOpen deviceId="dev-1" purpose="desktop" onSelect={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('session-picker-error')).toBeDefined());
  });
});
