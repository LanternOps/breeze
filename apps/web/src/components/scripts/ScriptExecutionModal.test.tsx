import '@/lib/i18n';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ScriptExecutionModal, { type Device } from './ScriptExecutionModal';
import type { ScriptParameter } from './ScriptFormSchema';
import type { Script } from './ScriptList';
import { fetchWithAuth } from '../../stores/auth';
import type { ScriptAdmissionResult } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

// The advanced-filter panel is closed on open, so `useFilterPreview` is disabled
// and never fetches — no transport stub is needed for these cases.

const devices: Device[] = [
  { id: 'd-1', hostname: 'ws-01', os: 'windows', status: 'online', siteId: 's-1', siteName: 'HQ' },
];

const baseScript: Script = {
  id: 'sc-1',
  name: 'Rotate token',
  language: 'powershell',
  category: 'Maintenance',
  osTypes: ['windows'],
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

const admittedResult: ScriptAdmissionResult = {
  requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'queued',
  targets: [{
    requestedDeviceId: 'd-1',
    admission: 'admitted',
    executionId: 'execution-1',
    commandId: 'command-1',
    batchId: 'batch-1',
  }],
};

function renderModal(
  parameters: ScriptParameter[],
  onExecute = vi.fn().mockResolvedValue(admittedResult),
  onClose = vi.fn(),
  availableDevices = devices,
) {
  render(
    <ScriptExecutionModal
      script={{ ...baseScript, parameters }}
      devices={availableDevices}
      isOpen
      onClose={onClose}
      onExecute={onExecute}
    />
  );
  return { onExecute, onClose };
}

/** Select the one online device and drive the two-step execute button. */
async function execute() {
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByText('Execute'));
  fireEvent.click(await screen.findByText('Confirm Execute'));
}

describe('ScriptExecutionModal sourced parameters (#3409 PR3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prompts for runtime parameters and shows bound ones read-only', () => {
    renderModal([
      { name: 'message', type: 'string', required: true },
      { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    expect(screen.getByText('Parameters')).toBeInTheDocument();
    const chip = screen.getByTestId('script-bound-parameter-api_key');
    expect(chip).toHaveTextContent('Supplied automatically from variable vendor_token');
    expect(chip.querySelector('input')).toBeNull();
  });

  it('shows the parameters section as read-only chips when every parameter is bound', () => {
    renderModal([
      { name: 'org', type: 'string', required: true, source: 'builtin', builtinKey: 'org.name' },
    ]);

    // The operator is about to run this on customer machines — the injected
    // contract must be visible even though there is nothing to fill in.
    expect(screen.getByText('Parameters')).toBeInTheDocument();
    const chip = screen.getByTestId('script-bound-parameter-org');
    expect(chip).toHaveTextContent('Supplied automatically from org.name');
    expect(chip.querySelector('input')).toBeNull();
    expect(screen.getByTestId('script-parameters-all-supplied')).toBeInTheDocument();
  });

  it('executes a fully-bound script and submits an empty parameters map', async () => {
    const { onExecute } = renderModal([
      { name: 'org', type: 'string', required: true, source: 'builtin', builtinKey: 'org.name' },
      { name: 'api_key', type: 'string', required: true, defaultValue: 'fallback', source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][2]).toEqual({});
    expect(screen.queryByText(/is required/)).toBeNull();
  });

  it('renders no parameters section when the script has no parameters at all', () => {
    renderModal([]);

    expect(screen.queryByText('Parameters')).toBeNull();
  });

  it('does not seed a bound parameter\'s default and never submits it', async () => {
    const { onExecute } = renderModal([
      { name: 'message', type: 'string', defaultValue: 'hello' },
      {
        name: 'api_key',
        type: 'string',
        required: true,
        defaultValue: 'fallback',
        source: 'tenantVariable',
        variableKey: 'vendor_token',
      },
    ]);

    // The runtime default IS seeded; the bound one's fallback is not — it is the
    // server's business, and a supplied value would come back in
    // `ignoredParameters`.
    expect(screen.getByDisplayValue('hello')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('fallback')).toBeNull();

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][2]).toEqual({ message: 'hello' });
  });

  it('lets a run proceed when the only unfilled required parameter is bound', async () => {
    const { onExecute } = renderModal([
      { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
      { name: 'message', type: 'string' },
    ]);

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/is required/)).toBeNull();
  });

  it('still blocks on a missing required RUNTIME parameter', () => {
    const { onExecute } = renderModal([
      { name: 'message', type: 'string', required: true },
      { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Execute'));

    expect(screen.getByText('Parameter "message" is required')).toBeInTheDocument();
    expect(onExecute).not.toHaveBeenCalled();
  });
});

describe('ScriptExecutionModal device option paging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{
          id: '00000000-0000-4000-8000-000000000099',
          hostname: 'zzz-beyond-old-prefix',
          displayName: null,
          osType: 'windows',
          status: 'online',
          siteId: null,
          siteName: null,
        }],
        page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '2026-08-24T00:00:00.000Z' },
      }),
    } as unknown as Response);
  });

  it('searches authorized server options when no legacy device list is supplied', async () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, parameters: [] }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn().mockResolvedValue(admittedResult)}
      />
    );

    expect(await screen.findByText('zzz-beyond-old-prefix')).toBeInTheDocument();
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).startsWith('/devices/options?'))).toBe(true);
    expect(fetchWithAuthMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });

  it('keeps execute disabled when the supporting option request fails', async () => {
    fetchWithAuthMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({ error: 'selector unavailable' }),
    } as unknown as Response);

    render(
      <ScriptExecutionModal
        script={{ ...baseScript, parameters: [] }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn().mockResolvedValue(admittedResult)}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('selector unavailable');
    expect(screen.getByRole('button', { name: 'Execute' })).toBeDisabled();
  });
});

describe('ScriptExecutionModal admission truth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders admitted targets as queued and schedules auto-close after 1.5 seconds', async () => {
    const onClose = vi.fn();
    renderModal([], vi.fn().mockResolvedValue(admittedResult), onClose);

    await execute();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('All selected devices were admitted and queued.')).toBeInTheDocument();
    expect(screen.getAllByText('Queued').length).toBeGreaterThan(0);
    expect(screen.queryByText(/completed/i)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => { await vi.runOnlyPendingTimersAsync(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a partial admission open and renders every target with its reason', async () => {
    const secondDevice: Device = {
      id: 'd-2', hostname: 'ws-02', os: 'windows', status: 'online', siteId: 's-1', siteName: 'HQ',
    };
    const onClose = vi.fn();
    renderModal([], vi.fn().mockResolvedValue({
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      status: 'partially_queued',
      targets: [
        { requestedDeviceId: 'd-1', admission: 'admitted', executionId: 'execution-1' },
        { requestedDeviceId: 'd-2', admission: 'suppressed', reasonCode: 'maintenance_suppressed' },
      ],
    } satisfies ScriptAdmissionResult), onClose, [...devices, secondDevice]);

    fireEvent.click(screen.getByText('Select all'));
    fireEvent.click(screen.getByText('Execute'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('Some devices were admitted and queued. Review the remaining targets.')).toBeInTheDocument();
    expect(screen.getAllByText('ws-01').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ws-02').length).toBeGreaterThan(0);
    expect(screen.getByText(/maintenance_suppressed/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps a typed rejection open beyond 1.5 seconds and shows the target reason', async () => {
    const onClose = vi.fn();
    renderModal([], vi.fn().mockResolvedValue({
      requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      status: 'rejected',
      targets: [{ requestedDeviceId: 'd-1', admission: 'denied', reasonCode: 'site_access_denied' }],
    } satisfies ScriptAdmissionResult), onClose);

    await execute();
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('No devices were admitted. Review the reasons below.')).toBeInTheDocument();
    expect(screen.getByText(/site_access_denied/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps transport failure distinct from a typed rejection', async () => {
    renderModal([], vi.fn().mockRejectedValue(new Error('network unavailable')));

    await execute();

    await vi.waitFor(() => expect(screen.getByText('network unavailable')).toBeInTheDocument());
    expect(screen.queryByText('No devices were admitted. Review the reasons below.')).toBeNull();
  });
});

// #3409 PR4c-2: secrets ride an env var the helper IPC cannot carry, so a
// user-context run refuses them server-side. Warn before the operator submits.
describe('ScriptExecutionModal secret parameters (#3409 PR4c-2)', () => {
  const secretParam: ScriptParameter = {
    name: 'api_token',
    source: 'tenantSecret',
    variableKey: 'vendor_password',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  const selectRunAs = (value: 'system' | 'user') => {
    fireEvent.change(screen.getByDisplayValue('System'), { target: { value } });
  };

  it('warns that secrets require system context once Run as user is selected', () => {
    renderModal([secretParam]);
    expect(screen.queryByTestId('script-secrets-require-system')).toBeNull();

    selectRunAs('user');

    expect(screen.getByTestId('script-secrets-require-system')).toHaveTextContent(
      /secret variables/i
    );
  });

  it('does not warn for a user run when no parameter is a secret', () => {
    renderModal([
      { name: 'api_key', type: 'string', source: 'tenantVariable', variableKey: 'vendor_token' },
    ]);

    selectRunAs('user');

    expect(screen.queryByTestId('script-secrets-require-system')).toBeNull();
  });

  it('is a warning, not a block — the run still submits', async () => {
    const { onExecute } = renderModal([secretParam]);
    selectRunAs('user');

    await execute();

    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(1));
    expect(onExecute.mock.calls[0][3]).toBe('user');
  });
});

// Paper cut (2026-08-28 pre-release sweep): statusFilter defaults to 'online',
// so a fleet of OS-compatible-but-offline devices renders the OS-mismatch
// empty state, sending the tech to check OS compatibility for no reason.
describe('ScriptExecutionModal empty state (2026-08-28 sweep)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const offlineWindowsDevices: Device[] = [
    { id: 'd-1', hostname: 'ws-01', os: 'windows', status: 'offline', siteId: 's-1', siteName: 'HQ' },
    { id: 'd-2', hostname: 'ws-02', os: 'windows', status: 'offline', siteId: 's-1', siteName: 'HQ' },
  ];

  it('blames the status filter, not the OS, when compatible devices are merely offline', () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, parameters: [] }}
        devices={offlineWindowsDevices}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    );

    expect(screen.getByText(/2 compatible devices are hidden by the status filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/requires Windows/i)).toBeNull();

    fireEvent.click(screen.getByText('Show all devices'));
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('still blames the OS when no device is OS-compatible at all', () => {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, parameters: [] }}
        devices={[{ id: 'd-3', hostname: 'mac-01', os: 'macos', status: 'online', siteId: 's-1', siteName: 'HQ' }]}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    );

    expect(screen.getByText(/requires Windows/i)).toBeInTheDocument();
  });
});

// Fix round 1 (review I-1/I-2/I-3): the same disambiguation on the SERVER
// options path, where the hidden count comes from the one-row probe. A blame
// message is an assertion about the fleet, so it may only be rendered on
// settled evidence — never while the probe is in flight, never after it fails,
// and never for a multi-OS script whose probe cannot be OS-narrowed.
describe('ScriptExecutionModal empty state on the server options path', () => {
  /** The probe is the only request with `limit=1`; the picker's own is `limit=100`. */
  const isProbe = (url: string) => /[?&]limit=1(?:&|$)/.test(url);

  function optionsPage(data: Array<Record<string, unknown>>, total: number) {
    return {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data,
        page: { nextCursor: null, returned: data.length, total, hasMore: false, observedAt: '2026-09-01T00:00:00.000Z' },
      }),
    } as unknown as Response;
  }

  const windowsOption = (id: string, hostname: string, status: string) => ({
    id, hostname, displayName: null, osType: 'windows', status, siteId: null, siteName: null,
  });

  /** No `devices` prop: the modal sources its options from the server. */
  function renderServerModal(osTypes: Script['osTypes'] = ['windows']) {
    render(
      <ScriptExecutionModal
        script={{ ...baseScript, osTypes, parameters: [] }}
        isOpen
        onClose={vi.fn()}
        onExecute={vi.fn()}
      />
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blames the status filter with the probe exact total, and the reset repopulates the picker', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (isProbe(url)) return Promise.resolve(optionsPage([windowsOption('d-1', 'ws-01', 'offline')], 3));
      if (url.includes('status=online')) return Promise.resolve(optionsPage([], 0));
      // After the reset: the picker's own query with the status filter lifted.
      return Promise.resolve(optionsPage([
        windowsOption('d-1', 'ws-01', 'offline'),
        windowsOption('d-2', 'ws-02', 'offline'),
        windowsOption('d-3', 'ws-03', 'offline'),
      ], 3));
    });

    renderServerModal();

    expect(await screen.findByText(/3 compatible devices are hidden by the status filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/requires Windows/i)).toBeNull();

    fireEvent.click(screen.getByText('Show all devices'));

    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(3));
  });

  it('renders NEITHER blame message when the probe fails', async () => {
    const probeBody = vi.fn().mockResolvedValue({ error: 'probe unavailable' });
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (isProbe(url)) {
        return Promise.resolve({ ok: false, status: 503, json: probeBody } as unknown as Response);
      }
      return Promise.resolve(optionsPage([], 0));
    });

    renderServerModal();

    // Control: prove the probe ran AND its failure body was consumed, so the
    // absences below are evidence about the fix rather than about timing.
    await waitFor(() => expect(probeBody).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByText('No devices found.')).toBeInTheDocument();
    expect(screen.queryByText(/hidden by the status filter/i)).toBeNull();
    expect(screen.queryByText(/requires Windows/i)).toBeNull();
  });

  it('blames the OS when the probe settles with a zero total', async () => {
    fetchWithAuthMock.mockImplementation(() => Promise.resolve(optionsPage([], 0)));

    renderServerModal();

    expect(await screen.findByText(/requires Windows/i)).toBeInTheDocument();
    expect(screen.queryByText(/hidden by the status filter/i)).toBeNull();
  });

  it('issues no probe and asserts nothing for a multi-OS script the probe cannot narrow', async () => {
    fetchWithAuthMock.mockImplementation(() => Promise.resolve(optionsPage([], 7)));

    renderServerModal(['windows', 'macos']);

    expect(await screen.findByText('No devices found.')).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(fetchWithAuthMock.mock.calls.some(([url]) => isProbe(String(url)))).toBe(false);
    expect(screen.queryByText(/hidden by the status filter/i)).toBeNull();
    expect(screen.queryByText(/requires Windows/i)).toBeNull();
  });

  it('probes with limit=1, the status filter lifted, and the script OS still bound', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (isProbe(url)) return Promise.resolve(optionsPage([windowsOption('d-1', 'ws-01', 'offline')], 2));
      return Promise.resolve(optionsPage([], 0));
    });

    renderServerModal();

    await screen.findByText(/2 compatible devices are hidden by the status filter/i);
    const probeUrl = String(fetchWithAuthMock.mock.calls.map(([url]) => String(url)).find(isProbe));
    expect(probeUrl).toMatch(/[?&]limit=1(?:&|$)/);
    expect(probeUrl).not.toMatch(/[?&]status=/);
    // The status filter is what the probe lifts; the OS constraint must stay,
    // or `total` counts devices this script can never run on (review I-2).
    expect(probeUrl).toContain('osType=windows');
  });
});
