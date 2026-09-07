import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      return jsonResponse({}, 404);
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // Fake timers let the poll loop (POLL_INTERVAL_MS = 2000) run to its deadline
  // in milliseconds of wall clock instead of minutes — the deadline path is
  // untestable with real timers.
  const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

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
      if (url.startsWith('/devices')) {
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
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }],
        }, 201);
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

  it('shows a typed rejection inline and never polls an execution', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'rejected',
          targets: [{
            requestedDeviceId: DEVICE_ID,
            admission: 'suppressed',
            reasonCode: 'maintenance_suppressed',
          }],
        }, 201);
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

    expect(await screen.findByText(/maintenance_suppressed/)).toBeInTheDocument();
    expect(onExecutionChange).not.toHaveBeenCalled();
    expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url).includes('/executions/'))).toBe(false);
  });

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

  // #3409 PR4c-2: a `tenantSecret` row is forced `required: true` and the shared
  // schema REJECTS a `defaultValue` on it, so gating Test Run on
  // "required with no default" over the whole list locked the button forever and
  // told the author to do something the schema forbids.
  it('leaves test runs enabled when the only required parameter is a secret', async () => {
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        parameters={[
          { name: 'api_token', type: 'string', required: true, source: 'tenantSecret', variableKey: 'vendor_password' },
        ]}
        isDirty={false}
        onSaveChanges={async () => true}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    expect(screen.getByTestId('test-run-button')).toBeEnabled();
    expect(screen.queryByText(/Required parameters without defaults/i)).toBeNull();
  });

  it('leaves test runs enabled when a required parameter is bound to a tenant variable', async () => {
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        parameters={[
          { name: 'api_key', type: 'string', required: true, source: 'tenantVariable', variableKey: 'vendor_token' },
        ]}
        isDirty={false}
        onSaveChanges={async () => true}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    expect(screen.getByTestId('test-run-button')).toBeEnabled();
  });

  // A bound parameter's `defaultValue` is the SERVER's fallback (resolved value
  // -> definition default -> missing). Sending it as a runtime value would be
  // ignored and reported back in `ignoredParameters`.
  it('never submits a bound parameter as a runtime value', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        return jsonResponse({ id: EXECUTION_ID, status: 'completed', exitCode: 0, stdout: '', stderr: '' });
      }
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        parameters={[
          { name: 'message', type: 'string', required: true, defaultValue: 'hello' },
          { name: 'api_key', type: 'string', required: true, defaultValue: 'fallback', source: 'tenantVariable', variableKey: 'vendor_token' },
          { name: 'org', type: 'string', required: true, defaultValue: 'seed', source: 'builtin', builtinKey: 'org.name' },
        ]}
        isDirty={false}
        onSaveChanges={async () => true}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));

    await waitFor(() => expect(
      fetchWithAuthMock.mock.calls.some(([url]) => url === `/scripts/${SCRIPT_ID}/execute`)
    ).toBe(true));
    const executeCall = fetchWithAuthMock.mock.calls.find(([url]) => url === `/scripts/${SCRIPT_ID}/execute`);
    const body = JSON.parse((executeCall![1] as RequestInit).body as string) as { parameters: Record<string, unknown> };
    expect(body.parameters).toEqual({ message: 'hello' });
  });

  it('treats a cancelled execution as terminal and shows its status', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }] }, 201);
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
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }] }, 201);
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
    expect(fetchWithAuthMock.mock.calls.some(([url]) => url.startsWith('/devices'))).toBe(false);
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

  it('terminalises the run on a permanent poll failure and re-polls the same execution on retry', async () => {
    vi.useFakeTimers();
    let polls = 0;
    let pollGone = true;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        polls += 1;
        if (pollGone) return jsonResponse({ error: 'gone' }, 404);
        return jsonResponse({ id: EXECUTION_ID, status: 'completed', exitCode: 0, stdout: 'recovered output', stderr: '' });
      }
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );
    await flush();
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
    await flush(4000);

    expect(polls).toBe(1);
    expect(screen.getByText(/could not read the run result/i)).toBeInTheDocument();
    // The run must not still be presented as in flight: no spinning status chip,
    // and the Run button is only re-enabled because nothing is running.
    expect(screen.queryByText('Queued')).toBeNull();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.getByTestId('test-run-button')).not.toBeDisabled();

    // Recovery must re-read the SAME execution, never start a second run.
    pollGone = false;
    fireEvent.click(screen.getByTestId('test-poll-retry'));
    await flush(4000);

    expect(screen.getByText('recovered output')).toBeInTheDocument();
    expect(polls).toBe(2);
    expect(fetchWithAuthMock.mock.calls.filter(([url]) => String(url).includes('/execute')).length).toBe(1);
  });

  it('keeps polling through a 429 — a rate limit is not a permanent failure', async () => {
    vi.useFakeTimers();
    let polls = 0;
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        polls += 1;
        if (polls <= 2) return jsonResponse({ error: 'rate limited' }, 429);
        return jsonResponse({ id: EXECUTION_ID, status: 'completed', exitCode: 0, stdout: 'after the limit', stderr: '' });
      }
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );
    await flush();
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
    await flush(10000);

    expect(polls).toBeGreaterThanOrEqual(3);
    expect(screen.getByText('after the limit')).toBeInTheDocument();
    expect(screen.queryByText(/could not read the run result/i)).toBeNull();
  });

  it('terminalises the run when the poll deadline expires', async () => {
    vi.useFakeTimers();
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [onlineDevice] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'queued', targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }] }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        return jsonResponse({ id: EXECUTION_ID, status: 'running' });
      }
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        timeoutSeconds={1}
        isDirty={false}
        onSaveChanges={async () => true}
      />
    );
    await flush();
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
    // Deadline is timeoutSeconds + 120s of slack.
    await flush(130_000);

    expect(screen.getByText(/still no result/i)).toBeInTheDocument();
    expect(screen.queryByText('Running')).toBeNull();
    expect(screen.queryByText('Queued')).toBeNull();
    expect(screen.getByTestId('test-run-button')).not.toBeDisabled();
    // Recovery is still possible without starting a second run.
    expect(screen.getByTestId('test-poll-retry')).toBeInTheDocument();
  });

  it('clears a pinned device that the new OS targets no longer allow', async () => {
    const onTestDeviceChange = vi.fn();
    const { rerender } = render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    expect(screen.getByTestId('test-run-button')).not.toBeDisabled();
    expect(localStorage.getItem(`breeze:script-test-device:${SCRIPT_ID}`)).toBe(DEVICE_ID);

    rerender(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['macos']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );

    // Wait on the pin actually being dropped, not on the <select>'s value: a
    // select whose value has no matching <option> already reports '' in the DOM,
    // which is the very bug this test exists for and would pass vacuously.
    await waitFor(() =>
      expect(localStorage.getItem(`breeze:script-test-device:${SCRIPT_ID}`)).toBeNull()
    );
    expect((screen.getByTestId('test-device-select') as HTMLSelectElement).value).toBe('');
    // Run must be blocked, not silently targeting the now-hidden device.
    expect(screen.getByTestId('test-run-button')).toBeDisabled();
    expect(onTestDeviceChange).toHaveBeenLastCalledWith(null);
  });

  it('asks for the fleet per OS target and at the API page-size cap', async () => {
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows', 'macos']}
        isDirty={false}
        onSaveChanges={async () => true}
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());

    const deviceUrls = fetchWithAuthMock.mock.calls
      .map(([url]) => url as string)
      .filter(url => url.startsWith('/devices'));
    // One server-filtered request per OS target — an unparameterised '/devices'
    // would default to 500 rows and silently hide the rest of the fleet.
    expect(deviceUrls).toHaveLength(2);
    expect(deviceUrls.some(u => u.includes('osType=windows'))).toBe(true);
    expect(deviceUrls.some(u => u.includes('osType=macos'))).toBe(true);
    expect(deviceUrls.every(u => u.includes('limit=1000'))).toBe(true);
  });

  it('says the device list failed to load instead of showing an empty picker', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/devices')) return jsonResponse({ error: 'boom' }, 500);
      return jsonResponse({}, 404);
    });

    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );

    // "No compatible devices" would read as a settled, correct answer — the
    // operator would go looking for a device that is in fact right there.
    await waitFor(() => expect(screen.getByText(/couldn't load devices/i)).toBeInTheDocument());
    expect(screen.queryByText(/no compatible devices/i)).toBeNull();
  });

  it('keeps a pinned device when the fetch fails rather than discarding the pin', async () => {
    const onTestDeviceChange = vi.fn();
    localStorage.setItem(`breeze:script-test-device:${SCRIPT_ID}`, DEVICE_ID);
    const { rerender } = render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );
    await waitFor(() =>
      expect((screen.getByTestId('test-device-select') as HTMLSelectElement).value).toBe(DEVICE_ID)
    );

    // The fleet fetch now fails, and the OS targets moved off windows so the
    // stale cached device no longer looks compatible either. That combination is
    // exactly when "not in the list" carries no information about the pin — the
    // reconcile must not fire on an unsettled fetch.
    fetchWithAuthMock.mockImplementation(async () => jsonResponse({ error: 'boom' }, 500));
    rerender(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['linux']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );
    await waitFor(() => expect(screen.getByText(/couldn't load devices/i)).toBeInTheDocument());

    expect(localStorage.getItem(`breeze:script-test-device:${SCRIPT_ID}`)).toBe(DEVICE_ID);
    expect(onTestDeviceChange).not.toHaveBeenCalledWith(null);
  });

  it('keeps a pinned device when the fleet page came back truncated', async () => {
    const onTestDeviceChange = vi.fn();
    localStorage.setItem(`breeze:script-test-device:${SCRIPT_ID}`, DEVICE_ID);
    const { rerender } = render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );
    await waitFor(() =>
      expect((screen.getByTestId('test-device-select') as HTMLSelectElement).value).toBe(DEVICE_ID)
    );

    // A full page means the pinned device may simply be past the cap. Deleting
    // the pin on that basis destroys the operator's choice permanently.
    const cappedPage = Array.from({ length: 1000 }, (_, i) => ({
      id: `filler-${i}`, hostname: `filler-${i}`, osType: 'windows', status: 'online',
    }));
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: cappedPage });
      return jsonResponse({}, 404);
    });
    rerender(
      <ScriptTestRunner
        scriptId={SCRIPT_ID}
        osTypes={['windows', 'linux']}
        isDirty={false}
        onSaveChanges={async () => true}
        onTestDeviceChange={onTestDeviceChange}
      />
    );
    await waitFor(() => expect(screen.getByText('filler-0')).toBeInTheDocument());

    expect(localStorage.getItem(`breeze:script-test-device:${SCRIPT_ID}`)).toBe(DEVICE_ID);
    expect(onTestDeviceChange).not.toHaveBeenCalledWith(null);
  });
});

// #4885/#4886 — once a test run completes, offer an explicit "Run again" next
// to the result and a link straight to where the full record lives.
describe('ScriptTestRunner post-run actions (#4885 / #4886)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  async function runToCompletion(execute: () => void) {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices')) return jsonResponse({ data: [
        onlineDevice,
        { ...onlineDevice, id: 'second-device', hostname: 'second-box' },
      ] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        execute();
        return jsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }],
        }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
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

    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
    await waitFor(() => expect(screen.getByText('hello from test-box')).toBeInTheDocument(), { timeout: 5000 });
  }

  it('offers a "Run again" action next to a completed run\'s output, which starts a new execution', async () => {
    let executeCalls = 0;
    await runToCompletion(() => { executeCalls += 1; });
    expect(executeCalls).toBe(1);

    fireEvent.click(screen.getByTestId('test-run-again'));

    await waitFor(() => expect(executeCalls).toBe(2));
  }, 10000);

  it('links straight to the device\'s Scripts tab for the execution once it has run', async () => {
    await runToCompletion(() => {});

    const link = screen.getByTestId('test-view-on-device') as HTMLAnchorElement;
    expect(link).toHaveAttribute('href', `/devices/${DEVICE_ID}#scripts/${EXECUTION_ID}`);
  }, 10000);

  it('does not render the device link before any run has started', () => {
    render(
      <ScriptTestRunner scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false} onSaveChanges={async () => true} />
    );

    expect(screen.queryByTestId('test-view-on-device')).toBeNull();
  });

  it('keeps the completed execution link on its original device after changing the next target', async () => {
    await runToCompletion(() => {});

    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: 'second-device' } });

    expect(screen.getByTestId('test-device-select')).toHaveValue('second-device');
    expect(screen.getByTestId('test-view-on-device')).toHaveAttribute(
      'href', `/devices/${DEVICE_ID}#scripts/${EXECUTION_ID}`
    );
  }, 10000);
});

/**
 * #4888 — Test Run's run-context control.
 *
 * Before this the editor's Test Run posted `{deviceIds, parameters,
 * triggerType}` and inherited whatever the form's advanced-settings default
 * was, with nothing on screen naming it. During the OliveTech GCPW debugging
 * (#4882) the same script ran alternately as SYSTEM and as the user with no
 * visible control over which, which is a large part of why the failures looked
 * random.
 */
describe('ScriptTestRunner — run context (#4888)', () => {
  // Local copy of the outer suite's timer flush — the poll loop's 2s interval
  // is otherwise untestable in wall-clock time.
  const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  const ON_DEMAND_DEVICE = {
    id: DEVICE_ID, hostname: 'test-box', osType: 'windows', status: 'online',
    helperLifecycleMode: 'on-demand',
  };

  function postBodies(): Array<Record<string, unknown>> {
    return fetchWithAuthMock.mock.calls
      .filter(([url, init]) => url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>);
  }

  function mockRun(device: Record<string, unknown> = onlineDevice, execution: Record<string, unknown> = {}) {
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/devices/') && url.endsWith('/sessions/live')) {
        return jsonResponse({ data: { sessions: [
          { sessionId: 3, username: 'olive\\tech', state: 'active', sessionType: 'console', helperConnected: true, idleMinutes: 0 },
        ] } });
      }
      if (url.startsWith('/devices')) return jsonResponse({ data: [device] });
      if (url === `/scripts/${SCRIPT_ID}/execute` && init?.method === 'POST') {
        return jsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: DEVICE_ID, admission: 'admitted', executionId: EXECUTION_ID }],
        }, 201);
      }
      if (url === `/scripts/executions/${EXECUTION_ID}`) {
        return jsonResponse({ id: EXECUTION_ID, status: 'completed', exitCode: 0, stdout: '', stderr: '', ...execution });
      }
      return jsonResponse({}, 404);
    });
  }

  async function selectDeviceAndRun() {
    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
  }

  /**
   * The regression this guards is a SILENT DOWNGRADE, not a missing feature. A
   * control offering only system/user that always posts a value would turn an
   * `elevated` script's next test run into a plain system run — quieter and
   * worse than the gap it replaced. Defaulting to "Script default" and posting
   * NO `runAs` is what keeps the server's own resolution in charge.
   */
  it('posts no runAs at all while "Script default" is selected', async () => {
    mockRun();
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true} scriptRunAs="elevated"
      />
    );
    await selectDeviceAndRun();

    await waitFor(() => expect(postBodies()).toHaveLength(1));
    expect(postBodies()[0]).not.toHaveProperty('runAs');
  });

  it('names the script default in the control so the inherited context is visible before running', async () => {
    mockRun();
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true} scriptRunAs="user"
      />
    );

    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    expect(screen.getByTestId('test-run-context')).toHaveTextContent(/script default \(logged-in user\)/i);
  });

  it('posts the chosen runAs when the author overrides the default', async () => {
    mockRun();
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true} scriptRunAs="system"
      />
    );
    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-run-context'), { target: { value: 'user' } });
    await selectDeviceAndRun();

    await waitFor(() => expect(postBodies()).toHaveLength(1));
    expect(postBodies()[0]!.runAs).toBe('user');
  });

  it('offers a session target only for a user run on an on-demand helper, and posts it', async () => {
    mockRun(ON_DEMAND_DEVICE);
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true} scriptRunAs="system"
      />
    );
    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    // Hidden until the context is actually `user` — the API rejects a session
    // id on any other run, so offering one would be a control that 400s.
    expect(screen.queryByTestId('test-run-session-target')).toBeNull();

    fireEvent.change(screen.getByTestId('test-run-context'), { target: { value: 'user' } });
    await waitFor(() => expect(screen.getByTestId('test-run-session-target')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-run-session-target'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('test-run-button'));

    await waitFor(() => expect(postBodies()).toHaveLength(1));
    expect(postBodies()[0]).toMatchObject({ runAs: 'user', targetSessionId: 3 });
  });

  it('never offers a session target for an always-on helper', async () => {
    mockRun({ ...onlineDevice, helperLifecycleMode: 'always-on' });
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true} scriptRunAs="system"
      />
    );
    await waitFor(() => expect(screen.getByText('test-box')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.change(screen.getByTestId('test-run-context'), { target: { value: 'user' } });

    expect(screen.queryByTestId('test-run-session-target')).toBeNull();
  });

  /**
   * The header reports the SERVER's resolution off the execution row, not an
   * echo of what the component sent — that is the difference between "we think
   * it ran as X" and "it ran as X".
   */
  it('shows the effective run context the execution row reports, not the local selection', async () => {
    vi.useFakeTimers();
    mockRun(onlineDevice, { runAs: 'elevated' });
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true} scriptRunAs="elevated"
      />
    );
    await flush();
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
    await flush(2500);

    expect(screen.getByTestId('test-run-effective-context')).toHaveTextContent(/elevated/i);
  });

  it('reports an unrecorded run context honestly rather than assuming System', async () => {
    vi.useFakeTimers();
    mockRun(onlineDevice, { runAs: null });
    render(
      <ScriptTestRunner
        scriptId={SCRIPT_ID} osTypes={['windows']} isDirty={false}
        onSaveChanges={async () => true}
      />
    );
    await flush();
    fireEvent.change(screen.getByTestId('test-device-select'), { target: { value: DEVICE_ID } });
    fireEvent.click(screen.getByTestId('test-run-button'));
    await flush(2500);

    const chip = screen.getByTestId('test-run-effective-context');
    expect(chip).toHaveTextContent(/not recorded/i);
    expect(chip).not.toHaveTextContent(/^Run context\s*System$/i);
  });
});
