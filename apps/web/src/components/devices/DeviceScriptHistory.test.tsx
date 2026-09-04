import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceScriptHistory from './DeviceScriptHistory';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

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
});
