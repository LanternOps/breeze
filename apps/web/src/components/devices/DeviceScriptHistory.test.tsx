import '@/lib/i18n';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceScriptHistory from './DeviceScriptHistory';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

type MockExecuteModalProps = {
  script: { id: string; name: string };
  initialDeviceIds?: string[];
  initialParameters?: Record<string, string | number | boolean>;
  onExecute: (
    scriptId: string,
    deviceIds: string[],
    parameters: Record<string, string | number | boolean>,
    runAs: 'system' | 'user'
  ) => Promise<unknown>;
  onClose: () => void;
};

vi.mock('../scripts/ScriptExecutionModal', () => ({
  default: ({ script, initialDeviceIds, initialParameters, onExecute, onClose }: MockExecuteModalProps) => (
    <div data-testid="mock-execution-modal">
      <div data-testid="mock-script-name">{script.name}</div>
      <div data-testid="mock-initial-device-ids">{JSON.stringify(initialDeviceIds ?? null)}</div>
      <div data-testid="mock-initial-parameters">{JSON.stringify(initialParameters ?? null)}</div>
      <button type="button" onClick={() => void onExecute(script.id, initialDeviceIds ?? [], initialParameters ?? {}, 'system')}>
        Confirm Run Again
      </button>
      <button type="button" onClick={onClose}>Close Modal</button>
    </div>
  ),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const DEVICE_ID = 'device-1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const executionRow = {
  id: 'exec-1',
  scriptId: 'script-1',
  scriptName: 'Collect Inventory',
  status: 'completed',
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  parameters: { target: 'C:\\Temp' },
  startedAt: '2026-02-08T00:00:00.000Z',
  completedAt: '2026-02-08T00:00:03.000Z',
};

const scriptDetail = {
  id: 'script-1',
  name: 'Collect Inventory',
  language: 'powershell',
  category: 'Maintenance',
  osTypes: ['windows'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('DeviceScriptHistory "Run again" (#4885)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) {
        return jsonResponse({ data: [executionRow] });
      }
      if (url === '/scripts/script-1') {
        return jsonResponse(scriptDetail);
      }
      return jsonResponse({}, 404);
    });
  });

  async function openDetails() {
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);
    fireEvent.click(await screen.findByText('Collect Inventory'));
    return screen.findByText('Execution Details');
  }

  it('fetches the script definition and opens the execute modal pre-filled on "Run again"', async () => {
    await openDetails();

    fireEvent.click(screen.getByTestId('device-script-run-again'));

    expect(await screen.findByTestId('mock-execution-modal')).toBeInTheDocument();
    expect(screen.getByTestId('mock-script-name')).toHaveTextContent('Collect Inventory');
    expect(screen.getByTestId('mock-initial-device-ids')).toHaveTextContent(JSON.stringify([DEVICE_ID]));
    expect(screen.getByTestId('mock-initial-parameters')).toHaveTextContent(JSON.stringify({ target: 'C:\\Temp' }));
    // The details view closed in favor of the execute flow.
    expect(screen.queryByText('Execution Details')).toBeNull();
  });

  it('refreshes history after a successful "Run again" submission', async () => {
    let executeCalls = 0;
    fetchWithAuthMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) {
        return jsonResponse({ data: [executionRow] });
      }
      if (url === '/scripts/script-1') return jsonResponse(scriptDetail);
      if (url === '/scripts/script-1/execute' && init?.method === 'POST') {
        executeCalls += 1;
        return jsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: 'exec-2' }],
        }, 201);
      }
      return jsonResponse({}, 404);
    });

    await openDetails();
    fireEvent.click(screen.getByTestId('device-script-run-again'));
    await screen.findByTestId('mock-execution-modal');
    fireEvent.click(screen.getByText('Confirm Run Again'));

    await waitFor(() => expect(executeCalls).toBe(1));
    // Two GETs to the history endpoint: the initial mount fetch, plus the
    // post-run refresh.
    await waitFor(() => {
      const historyCalls = fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === `/devices/${DEVICE_ID}/scripts`);
      expect(historyCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('toasts an error and does not open the execute modal when the script definition fails to load', async () => {
    fetchWithAuthMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) {
        return jsonResponse({ data: [executionRow] });
      }
      if (url === '/scripts/script-1') {
        return jsonResponse({ error: 'not found' }, 404);
      }
      return jsonResponse({}, 404);
    });

    await openDetails();
    fireEvent.click(screen.getByTestId('device-script-run-again'));

    await waitFor(() => expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' })
    ));
    expect(screen.queryByTestId('mock-execution-modal')).not.toBeInTheDocument();
  });

  it('toasts an error when the script-detail request itself rejects (network failure)', async () => {
    fetchWithAuthMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) {
        return jsonResponse({ data: [executionRow] });
      }
      if (url === '/scripts/script-1') {
        throw new Error('network unreachable');
      }
      return jsonResponse({}, 404);
    });

    await openDetails();
    fireEvent.click(screen.getByTestId('device-script-run-again'));

    await waitFor(() => expect(vi.mocked(showToast)).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'network unreachable' })
    ));
    expect(screen.queryByTestId('mock-execution-modal')).not.toBeInTheDocument();
  });
});

describe('DeviceScriptHistory highlighted execution (#4886)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) {
        return jsonResponse({ data: [executionRow] });
      }
      return jsonResponse({}, 404);
    });
  });

  it('auto-opens the details modal for the highlighted execution once it loads', async () => {
    render(<DeviceScriptHistory deviceId={DEVICE_ID} highlightExecutionId="exec-1" />);

    expect(await screen.findByText('Execution Details')).toBeInTheDocument();
  });

  it('does not auto-open anything when the highlighted id matches no execution', async () => {
    render(<DeviceScriptHistory deviceId={DEVICE_ID} highlightExecutionId="exec-does-not-exist" />);

    await screen.findByText('Collect Inventory');
    expect(screen.queryByText('Execution Details')).toBeNull();
  });

  // Guards `autoOpenedHighlightRef` (DeviceScriptHistory.tsx): the 10s poll
  // refresh must not keep resurrecting a modal the operator already dismissed.
  it('does not reopen the highlighted execution after it is closed once a 10s poll refresh runs', async () => {
    vi.useFakeTimers();
    const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
    try {
      render(<DeviceScriptHistory deviceId={DEVICE_ID} highlightExecutionId="exec-1" />);
      await flush();
      expect(screen.getByText('Execution Details')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Close'));
      expect(screen.queryByText('Execution Details')).toBeNull();

      // One full poll interval — fetchHistory(true) runs again with the same
      // (still-matching) execution row.
      await flush(10000);

      expect(screen.queryByText('Execution Details')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DeviceScriptHistory run context (#4888)', () => {
  function mockHistory(execution: Record<string, unknown>) {
    fetchWithAuthMock.mockImplementation(async (input: string) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) {
        return jsonResponse({ data: [execution] });
      }
      return jsonResponse({}, 404);
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the system context for a run recorded as system', async () => {
    mockHistory({ ...executionRow, runAs: 'system' });
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByText('Collect Inventory'));

    expect(await screen.findByTestId('run-context-chip')).toHaveTextContent('System');
  });

  it('names the target session for a run recorded as user with a session', async () => {
    mockHistory({ ...executionRow, runAs: 'user', targetSessionId: 3 });
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByText('Collect Inventory'));

    expect(await screen.findByTestId('run-context-chip')).toHaveTextContent('session 3');
  });

  it('renders "not recorded" -- never "System" -- for a null runAs', async () => {
    mockHistory({ ...executionRow, runAs: null });
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByText('Collect Inventory'));

    const chip = await screen.findByTestId('run-context-chip');
    expect(chip).toHaveTextContent('Not recorded');
    // This is the assertion that matters: a null runAs must never be
    // rendered as a plausible-but-invented "System", since the column is
    // nullable specifically because pre-#4888 rows genuinely don't know.
    expect(chip).not.toHaveTextContent('System');
  });
});
