import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScriptPickerModal from './ScriptPickerModal';
import { fetchWithAuth } from '../../stores/auth';

// --- Mocks ---

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// Scripts fixture
const SCRIPTS_DATA = [
  {
    id: 'p1',
    name: 'No Params',
    language: 'bash',
    category: 'General',
    osTypes: ['linux'],
  },
  {
    id: 'p2',
    name: 'With Params',
    language: 'bash',
    category: 'General',
    osTypes: ['linux'],
    parameters: [
      { name: 'message', type: 'string', required: true, defaultValue: '' },
      { name: 'count', type: 'number', required: false, defaultValue: '5' },
    ],
  },
];

// Live-sessions fixture (GET /devices/:id/sessions/live)
const SESSIONS_RESPONSE = {
  data: {
    deviceId: 'dev-1',
    sessions: [
      { sessionId: 1, username: 'console-user', state: 'active', type: 'console', helperConnected: false, idleMinutes: 0 },
      { sessionId: 5, username: 'bob', state: 'disconnected', type: 'rdp', helperConnected: false, idleMinutes: 90 },
    ],
  },
};

// Route the shared fetch mock by URL: /devices/... → live sessions, else scripts.
const routeFetchMock = () =>
  fetchWithAuthMock.mockImplementation(async (url: string) =>
    url.startsWith('/devices/') ? makeJsonResponse(SESSIONS_RESPONSE) : makeJsonResponse(SCRIPTS_DATA)
  );

describe('ScriptPickerModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(SCRIPTS_DATA));
  });

  it('selecting a parameterless script calls onSelect with undefined parameters and closes the modal', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    // Wait for scripts to load
    await waitFor(() => {
      expect(screen.getByText('No Params')).toBeDefined();
    });

    fireEvent.click(screen.getByText('No Params'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1', name: 'No Params' }),
      'system',
      undefined,
      undefined
    );
    expect(onClose).toHaveBeenCalled();

    // Should not have transitioned to params view
    expect(screen.queryByText('Configure Parameters')).toBeNull();
  });

  it('selecting a parameterized script transitions to params view and seeds defaults', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('With Params')).toBeDefined();
    });

    fireEvent.click(screen.getByText('With Params'));

    // Should NOT have called onSelect yet
    expect(onSelect).not.toHaveBeenCalled();

    // Params view header should appear with the script name
    expect(screen.getByText('Configure Parameters')).toBeDefined();
    expect(screen.getByText('With Params')).toBeDefined();

    // message input should be visible and empty
    const messageInput = screen.getByDisplayValue('') as HTMLInputElement;
    expect(messageInput).toBeDefined();

    // count input should be pre-filled with '5'
    const countInput = screen.getByDisplayValue('5') as HTMLInputElement;
    expect(countInput).toBeDefined();
  });

  it('clicking Run with a missing required field shows the error and does not call onSelect', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('With Params')).toBeDefined();
    });

    fireEvent.click(screen.getByText('With Params'));

    // Don't fill message — click Run Script without filling required field
    fireEvent.click(screen.getByText('Run Script'));

    expect(screen.getByText('Parameter "message" is required')).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('filling required param then Run calls onSelect with values and closes', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('With Params')).toBeDefined();
    });

    fireEvent.click(screen.getByText('With Params'));

    // Fill the message field
    const messageInput = screen.getByDisplayValue('') as HTMLInputElement;
    fireEvent.change(messageInput, { target: { value: 'hello' } });

    fireEvent.click(screen.getByText('Run Script'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p2', name: 'With Params' }),
      'system',
      expect.objectContaining({ message: 'hello', count: 5 }),
      undefined
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('Back button returns to list view and clears param state, re-selecting re-seeds defaults', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    render(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('With Params')).toBeDefined();
    });

    // Select the parameterized script
    fireEvent.click(screen.getByText('With Params'));

    // Type something in message
    const messageInput = screen.getByDisplayValue('') as HTMLInputElement;
    fireEvent.change(messageInput, { target: { value: 'dirty value' } });

    // Click Back
    fireEvent.click(screen.getByLabelText('Back to script list'));

    // List view should be visible again
    expect(screen.getByText('No Params')).toBeDefined();
    expect(screen.queryByText('Configure Parameters')).toBeNull();

    // Re-select With Params — should see fresh defaults (message = empty)
    fireEvent.click(screen.getByText('With Params'));

    expect(screen.getByDisplayValue('')).toBeDefined();
    expect(screen.queryByDisplayValue('dirty value')).toBeNull();
  });

  it('reopening the modal after viewing params returns to list view with cleared state', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    const { rerender } = render(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    await waitFor(() => {
      expect(screen.getByText('With Params')).toBeDefined();
    });

    // Select a parameterized script to transition to params view
    fireEvent.click(screen.getByText('With Params'));
    expect(screen.getByText('Configure Parameters')).toBeDefined();

    // Close the modal
    rerender(
      <ScriptPickerModal isOpen={false} onClose={onClose} onSelect={onSelect} />
    );

    // Reopen — reset fetch mock for second open
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(SCRIPTS_DATA));

    rerender(
      <ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />
    );

    // Should be back in list view
    await waitFor(() => {
      expect(screen.getByText('No Params')).toBeDefined();
    });

    expect(screen.queryByText('Configure Parameters')).toBeNull();
  });
});

describe('ScriptPickerModal session targeting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the session dropdown only for runAs=user on an on-demand device', async () => {
    routeFetchMock();
    render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="rds-01"
        deviceOs="windows" deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    // default runAs=system: no dropdown
    expect(screen.queryByTestId('script-session-target')).toBeNull();

    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('script-session-target')).toBeDefined());
    // disconnected sessions stay selectable for scripts
    expect(screen.getByText(/bob/)).toBeDefined();
  });

  it('never shows the dropdown without deviceId (bulk runs) or on always-on devices', () => {
    routeFetchMock();
    const { rerender } = render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="many" deviceOs="windows" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    expect(screen.queryByTestId('script-session-target')).toBeNull();

    rerender(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="ws-01"
        deviceOs="windows" deviceId="dev-2" helperLifecycleMode="always-on" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    expect(screen.queryByTestId('script-session-target')).toBeNull();
  });

  it('passes the chosen session to onSelect', async () => {
    routeFetchMock();
    const onSelect = vi.fn();
    render(
      // deviceOs omitted so the linux fixture scripts aren't OS-filtered out —
      // the session-target gate is independent of OS.
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={onSelect} deviceHostname="rds-01"
        deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('script-session-target')).toBeDefined());
    fireEvent.change(screen.getByTestId('script-session-target'), { target: { value: '5' } });

    // 'No Params' (id p1) is parameterless → selecting it fires onSelect immediately.
    await waitFor(() => expect(screen.getByText('No Params')).toBeDefined());
    fireEvent.click(screen.getByText('No Params'));

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      'user',
      undefined,
      5
    );
  });
});
