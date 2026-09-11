import '@/lib/i18n';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
const { showToastMock } = vi.hoisted(() => ({ showToastMock: vi.fn() }));

vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

const { default: DeviceScriptHistory } = await import('./DeviceScriptHistory');
const { useAuthStore } = await import('../../stores/auth');

const DEVICE_ID = 'device-1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function execution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-1',
    scriptId: 'script-1',
    scriptName: 'Collect Inventory',
    status: 'running',
    startedAt: '2026-02-08T00:00:00.000Z',
    ...overrides,
  };
}

function mockHistory(rows: Array<Record<string, unknown>>) {
  fetchWithAuthMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === `/devices/${DEVICE_ID}/scripts`) return jsonResponse({ data: rows });
    if (url === '/scripts/executions/exec-1/cancel' && init?.method === 'POST') {
      return jsonResponse({ success: true });
    }
    return jsonResponse({}, 404);
  });
}

function grantScriptsExecute() {
  useAuthStore.setState({
    user: {
      id: 'u1',
      email: 'tech@example.com',
      name: 'Tech',
      mfaEnabled: true,
      permissions: [{ resource: 'scripts', action: 'execute' }],
    },
  } as never);
}

describe('DeviceScriptHistory status labels (#5318)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantScriptsExecute();
  });

  it.each([
    ['pending', 'Pending'],
    ['queued', 'Queued — device offline'],
    ['cancelling', 'Stopping…'],
    ['cancelled', 'Cancelled'],
    ['timeout', 'Timeout'],
  ])('renders the shared human label for %s, never the raw enum', async (status, label) => {
    mockHistory([execution({ status })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    const badge = await screen.findByTestId('device-execution-status-exec-1');
    expect(badge).toHaveTextContent(label);
    expect(badge.textContent).not.toContain(status);
  });

  it('qualifies a terminal status when the stop request arrived too late', async () => {
    mockHistory([execution({ status: 'completed', cancelState: 'unconfirmed' })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('device-execution-status-exec-1'))
      .toHaveTextContent('your stop request arrived too late');
  });
});

describe('DeviceScriptHistory Stop action (#5318)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    grantScriptsExecute();
  });

  it.each(['pending', 'queued', 'running'])('offers Stop on %s', async (status) => {
    mockHistory([execution({ status })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('device-script-stop-exec-1')).toBeInTheDocument();
  });

  it.each(['completed', 'failed', 'timeout', 'cancelled'])('does not offer Stop on %s', async (status) => {
    mockHistory([execution({ status })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    await screen.findByText('Collect Inventory');
    expect(screen.queryByTestId('device-script-stop-exec-1')).toBeNull();
  });

  it('disables the Stop button while a stop is already in flight', async () => {
    mockHistory([execution({ status: 'cancelling' })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    expect(await screen.findByTestId('device-script-stop-exec-1')).toBeDisabled();
  });

  it('hides Stop entirely without scripts:execute', async () => {
    useAuthStore.setState({
      user: {
        id: 'u1', email: 'tech@example.com', name: 'Tech', mfaEnabled: true,
        permissions: [{ resource: 'scripts', action: 'read' }],
      },
    } as never);
    mockHistory([execution({ status: 'running' })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    await screen.findByText('Collect Inventory');
    expect(screen.queryByTestId('device-script-stop-exec-1')).toBeNull();
  });

  it('POSTs the shared cancel endpoint with the default grace period after confirming', async () => {
    mockHistory([execution({ status: 'running' })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('device-script-stop-exec-1'));
    fireEvent.click(await screen.findByTestId('confirm-stop'));

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/scripts/executions/exec-1/cancel');
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({ method: 'POST' });
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ graceSeconds: 5 });
    });
  });

  it('force stop sends a zero grace period', async () => {
    mockHistory([execution({ status: 'running' })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('device-script-stop-exec-1'));
    fireEvent.click(await screen.findByTestId('confirm-force-stop'));

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(([url]) => String(url) === '/scripts/executions/exec-1/cancel');
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ graceSeconds: 0 });
    });
  });

  it('offers Stop from the Execution Details panel too', async () => {
    mockHistory([execution({ status: 'running' })]);
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByText('Collect Inventory'));
    await screen.findByText('Execution Details');

    expect(screen.getByTestId('device-script-stop-details')).toBeInTheDocument();
  });

  it('surfaces a failed stop instead of failing silently', async () => {
    fetchWithAuthMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url === `/devices/${DEVICE_ID}/scripts`) return jsonResponse({ data: [execution({ status: 'running' })] });
      if (url === '/scripts/executions/exec-1/cancel' && init?.method === 'POST') {
        return jsonResponse({ error: 'Cannot cancel execution with status: completed' }, 409);
      }
      return jsonResponse({}, 404);
    });
    render(<DeviceScriptHistory deviceId={DEVICE_ID} />);

    fireEvent.click(await screen.findByTestId('device-script-stop-exec-1'));
    fireEvent.click(await screen.findByTestId('confirm-stop'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
  });
});
