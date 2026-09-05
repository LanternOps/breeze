import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ScriptExecutionsPage from './ScriptExecutionsPage';
import type { ScriptAdmissionResult } from '@breeze/shared';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

type MockExecuteModalProps = {
  onExecute: (scriptId: string, deviceIds: string[], parameters: Record<string, string | number | boolean>, runAs: 'system' | 'user') => Promise<ScriptAdmissionResult>;
  script: { id: string };
  initialDeviceIds?: string[];
  initialParameters?: Record<string, string | number | boolean>;
};

vi.mock('./ScriptExecutionModal', () => ({
  default: ({ onExecute, script, initialDeviceIds, initialParameters }: MockExecuteModalProps) => (
    <div>
      <div data-testid="mock-initial-device-ids">{JSON.stringify(initialDeviceIds ?? null)}</div>
      <div data-testid="mock-initial-parameters">{JSON.stringify(initialParameters ?? null)}</div>
      <button type="button" onClick={() => void onExecute(script.id, ['device-1'], {}, 'system')}>
        Confirm Execute
      </button>
    </div>
  ),
}));

const SCRIPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const EXECUTION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const script = {
  id: SCRIPT_ID,
  name: 'Disk Cleanup',
  language: 'powershell',
  category: 'Maintenance',
  osTypes: ['windows'],
  status: 'active',
};

// What GET /scripts/:id/executions actually returns: no stdout/stderr — the
// list endpoint strips them to keep the payload small.
const listRow = {
  id: EXECUTION_ID,
  scriptId: SCRIPT_ID,
  scriptName: 'Disk Cleanup',
  deviceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  deviceHostname: 'alpha-01',
  status: 'completed',
  startedAt: '2026-08-10T10:00:00.000Z',
  duration: 12,
  exitCode: 0,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const DETAIL_URL = `/scripts/executions/${EXECUTION_ID}`;

function mockApi(detail: () => Response) {
  fetchWithAuthMock.mockImplementation(async (url: string) => {
    if (url === `/scripts/${SCRIPT_ID}`) return jsonResponse({ script });
    if (url === `/scripts/${SCRIPT_ID}/executions`) return jsonResponse({ executions: [listRow] });
    if (url === '/devices') return jsonResponse({ devices: [] });
    if (url === '/orgs/sites') return jsonResponse({ sites: [] });
    if (url === DETAIL_URL) return detail();
    return jsonResponse({}, 404);
  });
}

async function openDetails() {
  render(<ScriptExecutionsPage scriptId={SCRIPT_ID} />);
  await screen.findByText('alpha-01');
  fireEvent.click(screen.getByTitle('View details'));
  return screen.findByText('Execution Details');
}

describe('ScriptExecutionsPage', () => {
  beforeEach(() => {
    mockApi(() =>
      jsonResponse({ ...listRow, stdout: 'FULL STDOUT FROM DETAIL', stderr: 'DETAIL STDERR' })
    );
  });

  it('fetches the full execution record and renders its stdout in the details modal', async () => {
    await openDetails();

    // The list row carries no stdout; without the follow-up fetch the modal is
    // permanently empty.
    expect(await screen.findByText('FULL STDOUT FROM DETAIL')).toBeInTheDocument();
    // stderr renders in a collapsed section (its defaultOpen was computed from
    // the stdout-less list row) — expand it and the fetched value is there too.
    fireEvent.click(screen.getByText('Standard Error (stderr)'));
    expect(await screen.findByText('DETAIL STDERR')).toBeInTheDocument();
    expect(fetchWithAuthMock.mock.calls.some(([url]) => url === DETAIL_URL)).toBe(true);
  });

  it('requests exactly the detail endpoint for the clicked execution', async () => {
    await openDetails();
    await screen.findByText('FULL STDOUT FROM DETAIL');

    const detailCalls = fetchWithAuthMock.mock.calls.filter(([url]) =>
      String(url).startsWith('/scripts/executions/')
    );
    expect(detailCalls).toHaveLength(1);
    expect(detailCalls[0][0]).toBe(DETAIL_URL);
  });

  it('keeps the list row metadata in the modal when the detail fetch fails', async () => {
    mockApi(() => jsonResponse({ error: 'boom' }, 500));

    await openDetails();
    await waitFor(() =>
      expect(fetchWithAuthMock.mock.calls.some(([url]) => url === DETAIL_URL)).toBe(true)
    );

    // The modal must not blank out or unmount: status, hostname and exit code
    // from the list row are still on screen.
    expect(screen.getByText('Execution Details')).toBeInTheDocument();
    expect(screen.getByText('Script completed successfully')).toBeInTheDocument();
    expect(screen.getAllByText('alpha-01').length).toBeGreaterThan(0);
    // No output is honest here — the detail record never arrived.
    expect(screen.getAllByText('No output').length).toBeGreaterThan(0);
  });

  it('keeps the modal usable when the detail fetch rejects outright', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === `/scripts/${SCRIPT_ID}`) return jsonResponse({ script });
      if (url === `/scripts/${SCRIPT_ID}/executions`) return jsonResponse({ executions: [listRow] });
      if (url === '/devices') return jsonResponse({ devices: [] });
      if (url === '/orgs/sites') return jsonResponse({ sites: [] });
      if (url === DETAIL_URL) throw new Error('network down');
      return jsonResponse({}, 404);
    });

    await openDetails();

    expect(screen.getByText('Execution Details')).toBeInTheDocument();
    expect(screen.getAllByText('alpha-01').length).toBeGreaterThan(0);
  });

  it('closes the details modal without leaving the fetched record on screen', async () => {
    await openDetails();
    await screen.findByText('FULL STDOUT FROM DETAIL');

    fireEvent.click(screen.getByText('Close'));

    await waitFor(() => expect(screen.queryByText('Execution Details')).toBeNull());
    expect(screen.queryByText('FULL STDOUT FROM DETAIL')).toBeNull();
  });

  it('refreshes executions only when the admission includes an admitted target', async () => {
    let executionListCalls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/scripts/${SCRIPT_ID}`) return jsonResponse({ script });
      if (url === `/scripts/${SCRIPT_ID}/executions`) {
        executionListCalls += 1;
        return jsonResponse({ executions: [listRow] });
      }
      if (url === '/orgs/sites') return jsonResponse({ sites: [] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: 'device-1', admission: 'admitted', executionId: 'execution-2' }],
        }, 201);
      }
      return jsonResponse({}, 404);
    });

    render(<ScriptExecutionsPage scriptId={SCRIPT_ID} />);
    fireEvent.click(await screen.findByText('Run Script'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => expect(executionListCalls).toBeGreaterThanOrEqual(2));
  });

  // #4885 — "Run again" from the execution-details modal.
  it('opens the execute modal pre-filled with the clicked execution\'s device and parameters', async () => {
    mockApi(() =>
      jsonResponse({
        ...listRow,
        stdout: 'FULL STDOUT FROM DETAIL',
        stderr: '',
        parameters: { target: 'C:\\Temp', force: true },
      })
    );

    await openDetails();
    await screen.findByText('FULL STDOUT FROM DETAIL');

    fireEvent.click(screen.getByTestId('execution-run-again'));

    // The details view is gone (replaced by the execute flow), and the
    // execute modal received exactly this execution's device + parameters —
    // not an empty/blank form.
    expect(screen.queryByText('Execution Details')).toBeNull();
    expect(await screen.findByTestId('mock-initial-device-ids')).toHaveTextContent(
      JSON.stringify([listRow.deviceId])
    );
    expect(screen.getByTestId('mock-initial-parameters')).toHaveTextContent(
      JSON.stringify({ target: 'C:\\Temp', force: true })
    );
  });

  it('does not refresh executions for a typed all-target rejection', async () => {
    let executionListCalls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/scripts/${SCRIPT_ID}`) return jsonResponse({ script });
      if (url === `/scripts/${SCRIPT_ID}/executions`) {
        executionListCalls += 1;
        return jsonResponse({ executions: [listRow] });
      }
      if (url === '/orgs/sites') return jsonResponse({ sites: [] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'rejected',
          targets: [{ requestedDeviceId: 'device-1', admission: 'denied', reasonCode: 'site_access_denied' }],
        }, 201);
      }
      return jsonResponse({}, 404);
    });

    render(<ScriptExecutionsPage scriptId={SCRIPT_ID} />);
    fireEvent.click(await screen.findByText('Run Script'));
    fireEvent.click(await screen.findByText('Confirm Execute'));
    await waitFor(() => expect(fetchWithAuthMock.mock.calls.some(([url]) => url === `/scripts/${SCRIPT_ID}/execute`)).toBe(true));

    expect(executionListCalls).toBe(1);
  });
});
