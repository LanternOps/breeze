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
  // #3409 PR3: one runtime parameter + one bound to a tenant variable. The
  // bound one is `required` on purpose — dispatch resolves it per device, so it
  // must not gate the Run button here.
  {
    id: 'p3',
    name: 'Mixed Params',
    language: 'bash',
    category: 'General',
    osTypes: ['linux'],
    parameters: [
      { name: 'message', type: 'string', required: true, defaultValue: '' },
      {
        name: 'api_key',
        type: 'string',
        required: true,
        defaultValue: 'fallback',
        source: 'tenantVariable',
        variableKey: 'vendor_token',
      },
    ],
  },
  {
    id: 'p4',
    name: 'All Bound',
    language: 'bash',
    category: 'General',
    osTypes: ['linux'],
    parameters: [
      { name: 'org', type: 'string', required: true, source: 'builtin', builtinKey: 'org.name' },
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

describe('ScriptPickerModal sourced parameters (#3409 PR3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse(SCRIPTS_DATA));
  });

  it('counts only runtime parameters in the prompt badge and names the injected ones separately', async () => {
    render(<ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Mixed Params')).toBeDefined());

    // "param(s)" stays the number the operator will be ASKED for; the injected
    // ones get their own badge so neither fact is over- or under-reported.
    const mixedRow = screen.getByText('Mixed Params').closest('button') as HTMLElement;
    expect(mixedRow).toHaveTextContent('1 param(s)');
    expect(mixedRow).toHaveTextContent('1 auto-supplied');

    // A fully-bound script asks for nothing, so it carries no prompt badge —
    // but it must not look parameterless either.
    const allBoundRow = screen.getByText('All Bound').closest('button') as HTMLElement;
    expect(allBoundRow).not.toHaveTextContent('param(s)');
    expect(allBoundRow).toHaveTextContent('1 auto-supplied');

    // A script with no parameters at all carries neither badge.
    const noneRow = screen.getByText('No Params').closest('button') as HTMLElement;
    expect(noneRow).not.toHaveTextContent('param(s)');
    expect(noneRow).not.toHaveTextContent('auto-supplied');
  });

  it('opens the params step for a fully-bound script and shows the injected contract', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('All Bound')).toBeDefined());

    fireEvent.click(screen.getByText('All Bound'));

    // The step is reachable, shows the chips, and fires nothing on its own.
    expect(screen.getByText('Configure Parameters')).toBeDefined();
    expect(screen.getByTestId('script-bound-parameter-org')).toHaveTextContent(
      'Supplied automatically from org.name'
    );
    expect(screen.getByTestId('script-parameters-all-supplied')).toBeDefined();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('lets a fully-bound script be run from the params step with an empty parameters map', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('All Bound')).toBeDefined());

    fireEvent.click(screen.getByText('All Bound'));
    // Nothing to fill in — the operator must still be able to continue.
    fireEvent.click(screen.getByText('Run Script'));

    expect(screen.queryByText(/is required/)).toBeNull();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p4' }),
      'system',
      {},
      undefined
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('still runs a parameterless script immediately, with no params step', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ScriptPickerModal isOpen onClose={onClose} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('No Params')).toBeDefined());

    fireEvent.click(screen.getByText('No Params'));

    expect(screen.queryByText('Configure Parameters')).toBeNull();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      'system',
      undefined,
      undefined
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a bound parameter read-only and never sends it in the parameters map', async () => {
    const onSelect = vi.fn();
    render(<ScriptPickerModal isOpen onClose={vi.fn()} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('Mixed Params')).toBeDefined());

    fireEvent.click(screen.getByText('Mixed Params'));

    // The bound parameter is visible, but as a chip — not an input, and its
    // definition default ("fallback") must NOT be seeded into paramValues.
    const chip = screen.getByTestId('script-bound-parameter-api_key');
    expect(chip).toHaveTextContent('Supplied automatically from variable vendor_token');
    expect(chip.querySelector('input')).toBeNull();
    expect(screen.queryByDisplayValue('fallback')).toBeNull();

    // Required-but-bound must not block the run.
    fireEvent.change(screen.getByDisplayValue(''), { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Run Script'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    const submitted = onSelect.mock.calls[0][2] as Record<string, unknown>;
    expect(submitted).toEqual({ message: 'hello' });
    expect(submitted).not.toHaveProperty('api_key');
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

// #3409 PR4c-2: a `tenantSecret` parameter rides an env var in the sealed
// command envelope. The server refuses the run outright for a user-context run
// AND for any targeted session (`runAsSupportsSecretEnv`), so this surface —
// which offers both controls — has to say so before the operator submits.
describe('ScriptPickerModal secret parameters (#3409 PR4c-2)', () => {
  const SECRET_SCRIPTS = [
    {
      id: 's1',
      name: 'Secret Script',
      language: 'bash',
      category: 'General',
      osTypes: ['linux', 'windows'],
      parameters: [
        { name: 'message', type: 'string', required: true, defaultValue: 'hi' },
        { name: 'api_token', type: 'string', required: true, source: 'tenantSecret', variableKey: 'vendor_password' },
      ],
    },
    {
      id: 's2',
      name: 'Plain Script',
      language: 'bash',
      category: 'General',
      osTypes: ['linux', 'windows'],
      parameters: [{ name: 'message', type: 'string', required: true, defaultValue: 'hi' }],
    },
  ];

  const routeSecretFetch = () =>
    fetchWithAuthMock.mockImplementation(async (url: string) =>
      url.startsWith('/devices/') ? makeJsonResponse(SESSIONS_RESPONSE) : makeJsonResponse(SECRET_SCRIPTS)
    );

  const openParamsFor = async (name: string) => {
    await waitFor(() => expect(screen.getByText(name)).toBeDefined());
    fireEvent.click(screen.getByText(name));
    await waitFor(() => expect(screen.getByText('Run Script')).toBeDefined());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    routeSecretFetch();
  });

  it('says nothing for an untargeted system run', async () => {
    render(<ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);
    await openParamsFor('Secret Script');
    expect(screen.queryByTestId('script-picker-secrets-require-system')).toBeNull();
  });

  it('warns once Run as user is selected', async () => {
    render(<ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Secret Script')).toBeDefined());
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await openParamsFor('Secret Script');

    expect(screen.getByTestId('script-picker-secrets-require-system')).toHaveTextContent(
      /secret variables/i
    );
  });

  it('warns when a specific session is targeted', async () => {
    render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="rds-01"
        deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('script-session-target')).toBeDefined());
    fireEvent.change(screen.getByTestId('script-session-target'), { target: { value: '5' } });
    await openParamsFor('Secret Script');

    expect(screen.getByTestId('script-picker-secrets-require-system')).toBeDefined();
  });

  it('says nothing for a user run when no parameter is a secret', async () => {
    render(<ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Plain Script')).toBeDefined());
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await openParamsFor('Plain Script');

    expect(screen.queryByTestId('script-picker-secrets-require-system')).toBeNull();
  });

  it('is a warning, not a block — the run still submits', async () => {
    const onSelect = vi.fn();
    render(<ScriptPickerModal isOpen onClose={vi.fn()} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('Secret Script')).toBeDefined());
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await openParamsFor('Secret Script');

    expect(screen.getByTestId('script-picker-secrets-require-system')).toBeDefined();
    fireEvent.click(screen.getByText('Run Script'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][1]).toBe('user');
  });
});

// The `script-run-as` and `script-session-target` selects had no accessible
// name at all (no <label>, no aria-label) -- every other run-context control
// in the app uses the labelled RunContextSelect. A screen-reader user gets
// two unnamed comboboxes with no way to tell what either one does.
describe('ScriptPickerModal accessible labels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes an accessible name for the run-as select', async () => {
    routeFetchMock();
    render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="rds-01"
        deviceOs="windows" deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    await waitFor(() => expect(screen.getByTestId('script-run-as')).toBeDefined());

    expect(screen.getByLabelText('Run as')).toBe(screen.getByTestId('script-run-as'));
  });

  it('exposes an accessible name for the session-target select', async () => {
    routeFetchMock();
    render(
      <ScriptPickerModal isOpen onClose={vi.fn()} onSelect={vi.fn()} deviceHostname="rds-01"
        deviceOs="windows" deviceId="dev-1" helperLifecycleMode="on-demand" />
    );
    fireEvent.change(screen.getByTestId('script-run-as'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('script-session-target')).toBeDefined());

    expect(screen.getByLabelText('Target session')).toBe(screen.getByTestId('script-session-target'));
  });
});
