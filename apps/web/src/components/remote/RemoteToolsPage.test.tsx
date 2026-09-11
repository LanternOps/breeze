import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RemoteToolsPage from './RemoteToolsPage';
import { fetchWithAuth } from '@/stores/auth';
import { showToast } from '@/components/shared/Toast';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// The real button drives desktop-session launch/deep-link flows unrelated to
// tab/hash behavior; only its presence matters for this suite.
vi.mock('./ConnectDesktopButton', () => ({
  default: () => <button type="button">connect</button>,
}));

// RemoteTerminal lazy-imports xterm.js and opens a WebSocket on mount — that
// machinery is covered by RemoteTerminal.test.tsx / RemoteTerminal.initFailure
// .test.tsx. Here we only need proof that RemoteToolsPage mounted the Terminal
// tab's content, so stub it out with a marker element. The stub also captures
// the props it was handed, which is how the onError wiring below is asserted.
const terminalStubProps: { onError?: (message: string) => void } = {};

vi.mock('./RemoteTerminal', () => ({
  default: (props: { onError?: (message: string) => void }) => {
    terminalStubProps.onError = props.onError;
    return <div data-testid="remote-terminal-stub" />;
  },
}));

vi.mock('@/components/shared/Toast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/shared/Toast')>()),
  showToast: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeResponse = (payload: unknown = {}, ok = false): Response =>
  ({
    ok,
    status: ok ? 200 : 404,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response);

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  terminalStubProps.onError = undefined;
  fetchMock.mockReset();
  // Nothing under test here depends on real device/process/service data —
  // every fetch resolves not-ok so effects bail out quietly.
  fetchMock.mockResolvedValue(makeResponse());
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
  cleanup();
});

const renderPage = () =>
  render(<RemoteToolsPage deviceId="device-1" deviceName="host-1" deviceOs="windows" />);

describe('RemoteToolsPage tab hash persistence (#4512)', () => {
  it('activates the Terminal tab on mount when the URL hash is #terminal', async () => {
    window.location.hash = '#terminal';

    renderPage();

    expect(await screen.findByTestId('remote-terminal-stub')).toBeInTheDocument();
  });

  it('defaults to the Processes tab when there is no hash', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('remote-terminal-stub')).not.toBeInTheDocument();
    });
  });

  it('falls back to the default tab when the hash names an unknown tab', async () => {
    window.location.hash = '#not-a-real-tab';

    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('remote-terminal-stub')).not.toBeInTheDocument();
    });
  });

  it('writes the clicked tab id to the URL hash and renders that tab', async () => {
    const user = userEvent.setup();
    renderPage();

    const terminalTabButton = await screen.findByRole('button', { name: 'Terminal' });
    await user.click(terminalTabButton);

    expect(window.location.hash).toBe('#terminal');
    expect(await screen.findByTestId('remote-terminal-stub')).toBeInTheDocument();
  });

  it('re-syncs the active tab on a hashchange event (back/forward navigation)', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.queryByTestId('remote-terminal-stub')).not.toBeInTheDocument();
    });

    act(() => {
      window.location.hash = '#terminal';
      window.dispatchEvent(new Event('hashchange'));
    });

    expect(await screen.findByTestId('remote-terminal-stub')).toBeInTheDocument();
  });

  it('falls back to the Processes tab when the hash names a windows-only tab on a non-Windows device (regression: hash bypasses OS gating)', async () => {
    window.location.hash = '#services';

    render(<RemoteToolsPage deviceId="device-1" deviceName="host-1" deviceOs="linux" />);

    // 'services' is windows-only and this device is linux, so the page must
    // not get stuck on a tab whose button/content never render.
    await waitFor(() => {
      expect(window.location.hash).toBe('#processes');
    });
    const processesButton = await screen.findByRole('button', { name: 'Processes' });
    expect(processesButton.className).toMatch(/border-primary/);
  });
});

// #4935: on an offline device the API answers 503 for the process list, and
// fetchProcesses swallowed that into `processes = []` — so the tab rendered
// "Processes 0 / No Data", indistinguishable from a genuinely idle box. The
// empty state must stay reserved for a real 200 with zero rows.
describe('RemoteToolsPage Processes tab surfaces an unavailable device (#4935)', () => {
  const OFFLINE_BODY = { error: 'The device is offline.', code: 'device_offline' };

  const makeStatusResponse = (payload: unknown, ok: boolean, status: number): Response =>
    ({
      ok,
      status,
      json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response);

  // Only the process-list route is under test; every other call (device info)
  // resolves not-ok so those effects bail out quietly.
  const mockProcessListResponse = (response: Response) => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/system-tools/devices/device-1/processes')
        ? response
        : makeResponse(),
    );
  };

  it('renders the offline reason instead of "No Data" when the API answers 503', async () => {
    mockProcessListResponse(makeStatusResponse(OFFLINE_BODY, false, 503));

    renderPage();

    expect(await screen.findByText('The device is offline.')).toBeInTheDocument();
    expect(screen.queryByText('No Data')).not.toBeInTheDocument();
    // The tiles must not report counts that were never fetched, and the footer
    // must not restate them — "Processes 0" was half of the reported symptom.
    expect(screen.getAllByText('-')).toHaveLength(3);
    expect(screen.queryByText(/Showing \d+ of \d+ processes/)).not.toBeInTheDocument();
  });

  it('offers a retry that re-requests the process list', async () => {
    const user = userEvent.setup();
    mockProcessListResponse(makeStatusResponse(OFFLINE_BODY, false, 503));

    renderPage();
    await screen.findByText('The device is offline.');

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/system-tools/devices/device-1/processes'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('keeps the "No Data" empty state for a genuine 200 with zero rows', async () => {
    mockProcessListResponse(makeStatusResponse({ data: [] }, true, 200));

    renderPage();

    expect(await screen.findByText('No Data')).toBeInTheDocument();
    expect(screen.queryByText('The device is offline.')).not.toBeInTheDocument();
    // A real zero is a real count: the tiles and footer stay as they were.
    expect(screen.getByText('Showing 0 of 0 processes')).toBeInTheDocument();
    expect(screen.queryByText('Retry')).not.toBeInTheDocument();
  });

  it('renders rows and no error for a 200 with processes', async () => {
    mockProcessListResponse(
      makeStatusResponse(
        {
          data: [
            { pid: 4242, name: 'svchost.exe', user: 'SYSTEM', cpuPercent: 1.5, memoryMB: 32 },
          ],
        },
        true,
        200,
      ),
    );

    renderPage();

    expect(await screen.findByText('svchost.exe')).toBeInTheDocument();
    expect(screen.queryByText('No Data')).not.toBeInTheDocument();
    expect(screen.queryByText('The device is offline.')).not.toBeInTheDocument();
  });

  it('clears the error once a retry succeeds', async () => {
    const user = userEvent.setup();
    mockProcessListResponse(makeStatusResponse(OFFLINE_BODY, false, 503));

    renderPage();
    await screen.findByText('The device is offline.');

    mockProcessListResponse(
      makeStatusResponse(
        { data: [{ pid: 7, name: 'explorer.exe', user: 'alice', cpuPercent: 0, memoryMB: 8 }] },
        true,
        200,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('explorer.exe')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('The device is offline.')).not.toBeInTheDocument();
    });
  });
});

// The terminal's only channel for reporting a failed initialisation is the
// onError prop. RemoteToolsPage never passed one, so a terminal that died on
// mount was completely silent — the defect behind #4152 was invisible to the
// user and to support.
describe('RemoteToolsPage surfaces terminal errors (#4152)', () => {
  it('passes an onError handler that raises a toast', async () => {
    window.location.hash = '#terminal';

    renderPage();
    await screen.findByTestId('remote-terminal-stub');

    expect(terminalStubProps.onError).toBeTypeOf('function');

    act(() => {
      terminalStubProps.onError!('Failed to initialize terminal');
    });

    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Failed to initialize terminal' }),
    );
  });
});

// #5088: the agent used to reject any service name containing an interior
// space ("Mesh Agent", "Bonjour Service", ...), and the API surfaced that as
// a 500 the Services panel silently swallowed — no toast, and the row was
// never re-fetched, so it just sat there looking unchanged. A failed
// start/stop/restart command must now toast and re-sync from the server.
describe('RemoteToolsPage Services tab surfaces failed commands (#5088)', () => {
  const makeServiceListBody = (status: 'running' | 'stopped') => ({
    data: [
      {
        name: 'Mesh Agent',
        displayName: 'Mesh Agent (Remote Support)',
        status,
        startType: 'auto',
        account: 'LocalSystem',
      },
    ],
  });

  const makeStatusResponse = (payload: unknown, ok: boolean, status: number): Response =>
    ({
      ok,
      status,
      json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response);

  // Only the services routes are under test; every other call (device info)
  // resolves not-ok so those effects bail out quietly.
  const mockServicesRoutes = (
    listBody: ReturnType<typeof makeServiceListBody>,
    actionSuffix: 'start' | 'stop' | 'restart',
    actionResponse: Response,
  ) => {
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url.includes('/services/') && url.endsWith(`/${actionSuffix}`) && options?.method === 'POST') {
        return actionResponse;
      }
      if (url.includes('/services?')) {
        return makeStatusResponse(listBody, true, 200);
      }
      return makeResponse();
    });
  };

  // One case per action. Each mocked failure message is deliberately
  // DIFFERENT from that action's runAction `errorFallback` copy (e.g.
  // "Failed to restart service" in src/locales/en/remote.json) — using the
  // fallback text verbatim would make the toast assertion pass identically
  // whether the server's real message was plumbed through or the code
  // silently fell back to the generic string after a body-parsing failure.
  const cases: Array<{
    action: 'start' | 'stop' | 'restart';
    buttonTitle: string;
    initialStatus: 'running' | 'stopped';
    serverMessage: string;
  }> = [
    {
      action: 'start',
      buttonTitle: 'Start Service',
      initialStatus: 'stopped',
      serverMessage: 'Access is denied by local security policy.',
    },
    {
      action: 'stop',
      buttonTitle: 'Stop Service',
      initialStatus: 'running',
      serverMessage: 'The service could not be stopped: dependent services are running.',
    },
    {
      action: 'restart',
      buttonTitle: 'Restart Service',
      initialStatus: 'running',
      serverMessage: 'The service did not respond to the restart request in time.',
    },
  ];

  it.each(cases)(
    'shows an error toast and re-syncs the row when a $action command fails',
    async ({ action, buttonTitle, initialStatus, serverMessage }) => {
      const user = userEvent.setup();
      mockServicesRoutes(
        makeServiceListBody(initialStatus),
        action,
        makeStatusResponse({ error: serverMessage, code: 'agent_execution_failed' }, false, 500),
      );

      window.location.hash = '#services';
      renderPage();

      expect(await screen.findByText('Mesh Agent')).toBeInTheDocument();

      // Icon-only row button: its accessible name comes from `title`.
      await user.click(screen.getByTitle(buttonTitle));
      // Confirm dialog button: has visible text, so getByText finds only it —
      // the row's icon button has no text node, only the same `title`.
      await user.click(screen.getByText(buttonTitle));

      await waitFor(() => {
        expect(showToast).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', message: serverMessage }),
        );
      });

      // The row must reflect a fresh read of ground truth after a failed
      // command, not the pre-action snapshot silently left in place — the
      // GET services list must be re-requested even though the mutation
      // failed.
      await waitFor(() => {
        const listCalls = fetchMock.mock.calls.filter(
          ([url]) => typeof url === 'string' && url.includes('/services?'),
        );
        expect(listCalls.length).toBeGreaterThanOrEqual(2);
      });
    },
  );
});

// Sweep 2026-09-08 (row 11, Group 1): fetchServices caught the fetch error
// into console.error and never told ServicesManager, so an offline device's
// 503 read as "0 of 0 services / No Services Available" — the exact #4935
// symptom, just on a different tab. ServicesManager now takes a `loadError`
// prop, mirroring ProcessManager.
describe('RemoteToolsPage Services tab surfaces an unavailable device (sweep 2026-09-08 row 11)', () => {
  const OFFLINE_BODY = { error: 'The device is offline.', code: 'device_offline' };

  const makeStatusResponse = (payload: unknown, ok: boolean, status: number): Response =>
    ({
      ok,
      status,
      json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response);

  const mockServiceListResponse = (response: Response) => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/system-tools/devices/device-1/services')
        ? response
        : makeResponse(),
    );
  };

  it('renders the offline reason instead of "No Services Available" when the API answers 503', async () => {
    window.location.hash = '#services';
    mockServiceListResponse(makeStatusResponse(OFFLINE_BODY, false, 503));

    renderPage();

    expect(await screen.findByText('The device is offline.')).toBeInTheDocument();
    expect(screen.queryByText('No Services Available')).not.toBeInTheDocument();
  });

  it('offers a retry that re-requests the service list', async () => {
    const user = userEvent.setup();
    window.location.hash = '#services';
    mockServiceListResponse(makeStatusResponse(OFFLINE_BODY, false, 503));

    renderPage();
    await screen.findByText('The device is offline.');

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.includes('/system-tools/devices/device-1/services'),
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('keeps the "No Services Available" empty state for a genuine 200 with zero rows', async () => {
    window.location.hash = '#services';
    mockServiceListResponse(makeStatusResponse({ data: [] }, true, 200));

    renderPage();

    expect(await screen.findByText('No Services Available')).toBeInTheDocument();
    expect(screen.queryByText('The device is offline.')).not.toBeInTheDocument();
  });
});

// Same swallow pattern, same fix, applied to the Scheduled Tasks tab
// (sweep 2026-09-08 row 11): fetchTasks discarded the error and ScheduledTasks
// had no loadError prop at all.
describe('RemoteToolsPage Scheduled Tasks tab surfaces an unavailable device (sweep 2026-09-08 row 11)', () => {
  const OFFLINE_BODY = { error: 'The device is offline.', code: 'device_offline' };

  const makeStatusResponse = (payload: unknown, ok: boolean, status: number): Response =>
    ({
      ok,
      status,
      json: vi.fn().mockResolvedValue(payload),
    } as unknown as Response);

  const mockTaskListResponse = (response: Response) => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/system-tools/devices/device-1/tasks')
        ? response
        : makeResponse(),
    );
  };

  it('renders the offline reason instead of the "not loaded" empty state when the API answers 503', async () => {
    window.location.hash = '#tasks';
    mockTaskListResponse(makeStatusResponse(OFFLINE_BODY, false, 503));

    renderPage();

    expect(await screen.findByText('The device is offline.')).toBeInTheDocument();
    expect(
      screen.queryByText('No scheduled tasks have been loaded for this device'),
    ).not.toBeInTheDocument();
  });

  it('keeps the "not loaded" empty state for a genuine 200 with zero rows', async () => {
    window.location.hash = '#tasks';
    mockTaskListResponse(makeStatusResponse({ data: [] }, true, 200));

    renderPage();

    expect(
      await screen.findByText('No scheduled tasks have been loaded for this device'),
    ).toBeInTheDocument();
    expect(screen.queryByText('The device is offline.')).not.toBeInTheDocument();
  });
});
