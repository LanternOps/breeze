import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SystemCleanupPanel from './SystemCleanupPanel';
import { fetchWithAuth } from '../../../stores/auth';

const showToast = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

vi.mock('../../shared/Toast', () => ({ showToast: (input: unknown) => showToast(input) }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status < 400, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const DEVICE = 'dev-1';
const CMD = 'cmd-1';
const RUN = 'run-1';

const catalog = {
  catalogVersion: 1,
  actions: [
    {
      id: 'linux_pkg_cache_clean', label: 'Package manager cache', description: 'Removes downloaded archives.',
      os: 'linux', available: true, estimateBytes: 412_000_000, estimateKnown: true,
      riskFlags: [], affectsVolumes: ['/'],
    },
    {
      id: 'linux_pkg_autoremove', label: 'Remove orphaned packages', description: 'Uninstalls dependency-only packages.',
      os: 'linux', available: true, estimateKnown: false,
      riskFlags: ['removes_packages'], affectsVolumes: ['/'],
    },
    {
      id: 'linux_journal_vacuum', label: 'Trim systemd journal', description: 'Vacuums archived journals.',
      os: 'linux', available: false, unavailableReason: 'journalctl not present', estimateKnown: false,
      riskFlags: [], affectsVolumes: ['/'],
    },
  ],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  showToast.mockReset();
});

function listFlow() {
  fetchWithAuthMock.mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
      return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
    }
    if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
      return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
    }
    throw new Error(`unexpected request ${url}`);
  });
}

describe('SystemCleanupPanel', () => {
  it('shows heuristic estimates with their explanation instead of an upper-bound label', async () => {
    const estimateDetail = 'heuristic: DISM /AnalyzeComponentStore reports component-store overhead, which is not the same as what the cleanup frees';
    fetchWithAuthMock.mockImplementation((input, init) => {
      if (String(input).endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      return Promise.resolve(json({ success: true, data: {
        status: 'completed',
        catalog: { ...catalog, actions: [{
          ...catalog.actions[0], id: 'win_dism_component_cleanup', os: 'windows',
          label: 'Component store cleanup', estimateBytes: 3_221_225_472, estimateDetail,
        }] },
      } }));
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    const estimate = await screen.findByTestId('system-cleanup-estimate-win_dism_component_cleanup');
    expect(screen.getByTestId('system-cleanup-row-win_dism_component_cleanup')).toHaveTextContent(estimateDetail);
    expect(estimate).toHaveTextContent('3 GB');
    expect(estimate).not.toHaveTextContent(/up to|systemCleanupPanel\.estimateUpTo/i);
  });

  it('lists actions with "up to" estimates, unknown sizes and unavailable reasons', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);

    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    expect(await screen.findByText('Package manager cache')).toBeInTheDocument();
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_cache_clean')).toBeInTheDocument();
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_autoremove')).toBeInTheDocument();
    expect(screen.getByTestId('system-cleanup-row-linux_journal_vacuum')).toHaveTextContent('journalctl not present');
    expect(screen.getByTestId('system-cleanup-check-linux_journal_vacuum')).toBeDisabled();
    expect(screen.getByTestId('system-cleanup-risk-linux_pkg_autoremove-removes_packages')).toBeInTheDocument();
  });

  it('requires the extra acknowledgement, and names the loss, for an irreversible action', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Remove orphaned packages');

    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_autoremove'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));

    const confirm = await screen.findByTestId('system-cleanup-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByTestId('system-cleanup-ack-irreversible'));
    expect(screen.getByTestId('system-cleanup-confirm')).toHaveAttribute('aria-disabled', 'false');
    // The dialog must name WHICH loss is about to happen — a generic
    // "are you sure" is the failure mode spec §13 #15 is about.
    expect(screen.getByTestId('system-cleanup-consequence-removes_packages')).toBeInTheDocument();
  });

  it('arms the same gate for an action that removes OS rollback', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      return Promise.resolve(json({
        success: true,
        data: {
          status: 'completed',
          catalog: {
            catalogVersion: 1,
            volumesBefore: [],
            actions: [{
              id: 'win_cleanmgr:previous_installations', label: 'Previous Windows installations',
              description: 'Removes Windows.old.', os: 'windows', available: true, estimateKnown: false,
              riskFlags: ['removes_os_rollback'], affectsVolumes: [],
            }],
          },
        },
      }));
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Previous Windows installations');
    fireEvent.click(screen.getByTestId('system-cleanup-check-win_cleanmgr:previous_installations'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));

    expect(await screen.findByTestId('system-cleanup-confirm')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('system-cleanup-consequence-removes_os_rollback')).toBeInTheDocument();
  });

  // Spec §13 #4: one native run per device. 409 run_in_progress is a distinct
  // answer from the agent-update 409 and must not raise the update banner.
  it('surfaces run_in_progress without claiming the agent needs an update', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
        return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
      }
      return Promise.resolve(json({ success: false, error: 'run_in_progress', cleanupRunId: RUN }, 409));
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));
    fireEvent.click(await screen.findByTestId('system-cleanup-confirm'));

    expect(await screen.findByTestId('system-cleanup-error')).toHaveAttribute('role', 'alert');
    expect(screen.queryByTestId('system-cleanup-agent-update')).toBeNull();
  });

  it('does not show the extra acknowledgement when nothing is irreversible', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');

    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));

    await screen.findByTestId('system-cleanup-confirm');
    expect(screen.queryByTestId('system-cleanup-ack-irreversible')).toBeNull();
    expect(screen.getByTestId('system-cleanup-confirm')).toHaveAttribute('aria-disabled', 'false');
  });

  it('posts only the checked ids and renders the measured result', async () => {
    let runPolls = 0;
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
        return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
      }
      if (url.endsWith('/filesystem/system-cleanup/run') && init?.method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ actionIds: ['linux_pkg_cache_clean'] });
        return Promise.resolve(json({ success: true, data: { cleanupRunId: RUN, commandId: CMD } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/run/${RUN}`)) {
        runPolls += 1;
        if (runPolls === 1) {
          return Promise.resolve(json({ success: true, data: { cleanupRunId: RUN, status: 'running', actions: [], volumes: [], freedBytes: 0, error: null } }));
        }
        return Promise.resolve(json({
          success: true,
          data: {
            cleanupRunId: RUN, status: 'executed', error: null, freedBytes: 3_221_225_472,
            actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }],
            volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 3_221_226_472 }],
          },
        }));
      }
      throw new Error(`unexpected request ${url}`);
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));
    fireEvent.click(await screen.findByTestId('system-cleanup-confirm'));

    expect(await screen.findByTestId('system-cleanup-running')).toBeInTheDocument();
    const result = await screen.findByTestId('system-cleanup-result', {}, { timeout: 5_000 });
    expect(result).toBeInTheDocument();
    expect(screen.getByTestId('system-cleanup-volume-/')).toBeInTheDocument();
  });

  it('surfaces a failed run even when it has no action results', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      if (url.endsWith(`/filesystem/system-cleanup/list/${CMD}`)) {
        return Promise.resolve(json({ success: true, data: { status: 'completed', catalog } }));
      }
      if (url.endsWith('/filesystem/system-cleanup/run') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { cleanupRunId: RUN, commandId: CMD } }, 202));
      }
      return Promise.resolve(json({ success: true, data: {
        cleanupRunId: RUN, status: 'failed', error: 'timed out',
        actions: [], volumes: [], freedBytes: 0,
      } }));
    });

    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    fireEvent.click(screen.getByTestId('system-cleanup-check-linux_pkg_cache_clean'));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));
    fireEvent.click(await screen.findByTestId('system-cleanup-confirm'));

    expect(await screen.findByTestId('system-cleanup-error')).toHaveTextContent('timed out');
    expect(screen.getByTestId('system-cleanup-error')).toHaveAttribute('role', 'alert');
  });

  // Spec §8: a 409 on either call renders the banner and disables Run.
  it('renders the agent-update banner on a 409 and disables Run', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({ success: false, error: 'agent_update_required', minAgentVersion: '0.115.0' }, 409),
    );
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    const banner = await screen.findByTestId('system-cleanup-agent-update');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('system-cleanup-run')).toBeDisabled();
  });

  // G3-1 (v0.114.0->main pass-3 paper cut): the initial POST that queues the
  // catalog check can itself 409 agent_update_required (before there is ever
  // a commandId to poll), which goes through runAction — the toast must say
  // the same human-readable thing as the banner, not the raw error token.
  it('toasts the human-readable agent-update copy, not the raw error code, on Check available actions', async () => {
    fetchWithAuthMock.mockResolvedValue(
      json({ success: false, error: 'agent_update_required', minAgentVersion: '0.115.0' }, 409),
    );
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    await screen.findByTestId('system-cleanup-agent-update');
    expect(showToast).toHaveBeenCalled();
    const toastArg = showToast.mock.calls[0][0] as { message: string };
    expect(toastArg.message).not.toContain('agent_update_required');
    expect(toastArg.message).toContain("Update this device's agent to version 0.115.0 or later");
  });

  // runAction toasts every non-401 failure; the panel must not swallow it.
  it('surfaces a failed list request', async () => {
    fetchWithAuthMock.mockResolvedValue(json({ success: false, error: 'Device is offline' }, 500));
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(await screen.findByTestId('system-cleanup-error')).toHaveAttribute('role', 'alert');
  });

  // Defect 9 in the spec's current-state table: the old tab's poll loop
  // survived unmount. Nothing may be fetched after the component is gone.
  it('stops polling on unmount', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/filesystem/system-cleanup/list') && init?.method === 'POST') {
        return Promise.resolve(json({ success: true, data: { commandId: CMD, status: 'pending' } }, 202));
      }
      return Promise.resolve(json({ success: true, data: { status: 'running' } }));
    });

    const { unmount } = render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    unmount();

    const callsAtUnmount = fetchWithAuthMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(fetchWithAuthMock.mock.calls.length).toBe(callsAtUnmount);
  });

  it('renders localised copy, not raw key paths', async () => {
    listFlow();
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    // A missing key echoes its own path, which is the failure mode this catches.
    expect(screen.getByTestId('system-cleanup-check').textContent).not.toContain('systemCleanupPanel.');
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    await screen.findByText('Package manager cache');
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_cache_clean')).toHaveTextContent(/up to 392\.91 MB/i);
    expect(screen.getByTestId('system-cleanup-estimate-linux_pkg_autoremove')).toHaveTextContent(/unknown/i);
    expect(screen.getByTestId('system-cleanup-risk-linux_pkg_autoremove-removes_packages').textContent)
      .not.toContain('systemCleanupPanel.');
  });
});


describe('cleanmgr sub-action selection', () => {
  it('requires selected handler rollback acknowledgements and never submits the parent id', async () => {
    const previousId = 'win_cleanmgr:previous_installations';
    const driverId = 'win_cleanmgr:device_driver_packages';
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith('/list') && init?.method === 'POST') return Promise.resolve(json({ success: true, data: { commandId: CMD } }));
      if (url.endsWith(`/list/${CMD}`)) return Promise.resolve(json({ data: { status: 'completed', catalog: {
        ...catalog, actions: [{ ...catalog.actions[0], id: 'win_cleanmgr', os: 'windows', riskFlags: ['long_running'], subActions: [
          { id: previousId, label: 'Previous installations', estimateBytes: 1024, estimateKnown: true, riskFlags: ['removes_os_rollback'] },
          { id: driverId, label: 'Driver packages', estimateKnown: false, riskFlags: ['removes_driver_rollback'] },
        ] }],
      } } }));
      if (url.endsWith('/run')) return Promise.resolve(json({ success: true, data: { cleanupRunId: RUN } }));
      return Promise.resolve(json({ data: { cleanupRunId: RUN, status: 'executed', error: null, freedBytes: 0, actions: [], volumes: [] } }));
    });
    render(<SystemCleanupPanel deviceId={DEVICE} />);
    fireEvent.click(screen.getByTestId('system-cleanup-check'));
    const previous = await screen.findByTestId(`system-cleanup-check-${previousId}`);
    expect(screen.queryByTestId('system-cleanup-check-win_cleanmgr')).not.toBeInTheDocument();
    expect(screen.getByTestId(`system-cleanup-risk-${previousId}-removes_os_rollback`)).toBeInTheDocument();
    expect(screen.getByTestId(`system-cleanup-estimate-${previousId}`)).toHaveTextContent('1 KB');
    fireEvent.click(previous);
    fireEvent.click(screen.getByTestId(`system-cleanup-check-${driverId}`));
    fireEvent.click(screen.getByTestId('system-cleanup-run'));
    expect(screen.getByTestId('system-cleanup-confirm')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('system-cleanup-consequence-removes_os_rollback')).toBeInTheDocument();
    expect(screen.getByTestId('system-cleanup-consequence-removes_driver_rollback')).not.toHaveTextContent('systemCleanupPanel.');
    fireEvent.click(screen.getByTestId('system-cleanup-ack-irreversible'));
    fireEvent.click(screen.getByTestId('system-cleanup-confirm'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringMatching(/\/run$/), expect.objectContaining({ body: JSON.stringify({ actionIds: [previousId, driverId] }) })));
  });
});
