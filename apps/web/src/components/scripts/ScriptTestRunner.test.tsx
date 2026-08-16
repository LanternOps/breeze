import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ScriptTestRunner from './ScriptTestRunner';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const SCRIPT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const EXECUTION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// Real GET /devices shape: the API emits `osType`, not `os` — the component
// must normalise (regression: the picker filtered on `os` and matched nothing).
const onlineDevice = { id: DEVICE_ID, hostname: 'test-box', osType: 'windows', status: 'online' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('ScriptTestRunner', () => {
  beforeEach(() => {
    localStorage.clear();
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/devices') return jsonResponse({ data: [onlineDevice] });
      return jsonResponse({}, 404);
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('disables test runs and explains why when the script was never saved', async () => {
    render(
      <ScriptTestRunner osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );

    expect(await screen.findByText(/save the script once/i)).toBeInTheDocument();
    expect(screen.getByTestId('test-run-button')).toBeDisabled();
    expect(screen.getByTestId('test-device-select')).toBeDisabled();
  });

  it('filters the device list to the script OS targets', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/devices') {
        return jsonResponse({ data: [
          onlineDevice,
          { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', hostname: 'mac-box', osType: 'macos', status: 'online' },
        ] });
      }
      return jsonResponse({}, 404);
    });
    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    expect(screen.queryByText('mac-box')).toBeNull();
  });

  it('runs on the selected device and renders the execution output when it completes', async () => {
    let polls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/devices') return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ executions: [{ executionId: EXECUTION_ID, deviceId: DEVICE_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        polls += 1;
        return jsonResponse({
          id: EXECUTION_ID,
          status: 'completed',
          exitCode: 0,
          stdout: 'hello from test-box',
          stderr: '',
        });
      }
      return jsonResponse({}, 404);
    });

    const onExecutionChange = vi.fn();
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        isDirty={false}
        onSaveChanges={async () => true}
        onExecutionChange={onExecutionChange}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));

    await waitFor(() => expect(onExecutionChange).toHaveBeenCalledWith(EXECUTION_ID));
    await waitFor(
      () => expect(screen.getByText('hello from test-box')).toBeInTheDocument(),
      { timeout: 5000 }
    );
    expect(polls).toBeGreaterThan(0);

    const executeCall = fetchWithAuthMock.mock.calls.find(([url]) => url === `/scripts/${SCRIPT_ID}/execute`);
    expect(JSON.parse((executeCall![1] as RequestInit).body as string)).toMatchObject({
      deviceIds: [DEVICE_ID],
      triggerType: 'manual',
    });
  }, 10000);

  it('saves first when the form is dirty and aborts the run when the save fails', async () => {
    const onSaveChanges = vi.fn(async () => false);
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        isDirty={true}
        onSaveChanges={onSaveChanges}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    expect(screen.getByTestId('test-run-button')).toHaveTextContent(/save/i);
    fireEvent.click(screen.getByTestId('test-run-button'));

    await waitFor(() => expect(onSaveChanges).toHaveBeenCalledTimes(1));
    // The execute endpoint must never be hit after a failed save.
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).includes('/execute'))).toBe(false);
    expect(await screen.findByText(/save failed/i)).toBeInTheDocument();
  });

  it('blocks runs when a required parameter has no default', async () => {
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        parameters={[{ name: 'target', type: 'string', required: true, defaultValue: '' }]}
        isDirty={false}
        onSaveChanges={async () => true}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    expect(screen.getByTestId('test-run-button')).toBeDisabled();
    expect(screen.getByText(/target/)).toBeInTheDocument();
  });

  it('treats a cancelled execution as terminal and shows its status', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/devices') return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ executions: [{ executionId: EXECUTION_ID, deviceId: DEVICE_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        return jsonResponse({ id: EXECUTION_ID, status: 'cancelled', stdout: '', stderr: '' });
      }
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );
    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));

    await waitFor(
      () => expect(screen.getByText(/cancelled/i)).toBeInTheDocument(),
      { timeout: 5000 }
    );
    // Terminal — the button is usable again, no deadline error.
    expect(screen.getByTestId('test-run-button')).not.toBeDisabled();
  }, 10000);

  it('stops polling on a permanent 404 instead of retrying to the deadline', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/devices') return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ executions: [{ executionId: EXECUTION_ID, deviceId: DEVICE_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) return jsonResponse({ error: 'gone' }, 404);
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );
    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));

    await waitFor(
      () => expect(screen.getByText(/could not read the run result/i)).toBeInTheDocument(),
      { timeout: 5000 }
    );
    const pollCalls = fetchWithAuthMock.mock.calls.filter(([url]) => String(url).includes('/executions/'));
    expect(pollCalls.length).toBe(1);
  }, 10000);

  it('does not fetch the device list for a never-saved script', async () => {
    render(
      <ScriptTestRunner osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );
    await screen.findByText(/save the script once/i);
    expect(fetchWithAuthMock.mock.calls.some(([url]) => url === '/devices')).toBe(false);
  });

  it('remembers the pinned device per script and reports it to the parent', async () => {
    localStorage.setItem(`breeze:script-test-device:${SCRIPT_ID}`, DEVICE_ID);
    const onTestDeviceChange = vi.fn();
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );

    await waitFor(() => expect(onTestDeviceChange).toHaveBeenCalledWith(DEVICE_ID));
    expect((screen.getByTestId('test-device-select') as HTMLSelectElement).value).toBe(DEVICE_ID);
  });
});
