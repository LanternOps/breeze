import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';
import type { ScriptAdmissionResult } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const showToastMock = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToastMock(a) }));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ currentOrgId: null, organizations: [] }), {
    getState: () => ({ currentOrgId: null, organizations: [] })
  })
}));

vi.mock('./ScriptList', () => ({
  default: ({
    scripts,
    onRun,
    onDuplicate
  }: {
    scripts: Array<{ id: string; name: string; lastRun?: string }>;
    onRun?: (script: { id: string; name: string; lastRun?: string }) => void;
    onDuplicate?: (script: { id: string; name: string; lastRun?: string }) => void;
  }) => (
    <div>
      {scripts.map(script => (
        <div key={script.id}>
          <span data-testid={`last-run-${script.id}`}>{script.lastRun ?? 'Never'}</span>
          <button type="button" onClick={() => onRun?.(script)}>
            Run {script.name}
          </button>
          <button type="button" onClick={() => onDuplicate?.(script)}>
            Duplicate {script.name}
          </button>
        </div>
      ))}
    </div>
  )
}));

vi.mock('./ScriptExecutionModal', () => ({
  default: ({
    isOpen,
    onExecute,
    script
  }: {
    isOpen: boolean;
    onExecute: (scriptId: string, deviceIds: string[], parameters: Record<string, string | number | boolean>, runAs: 'system' | 'user') => Promise<ScriptAdmissionResult>;
    script: { id: string };
  }) =>
    isOpen ? (
      <>
        <button
          type="button"
          onClick={() => void onExecute(script.id, ['device-1'], {}, 'system')}
        >
          Confirm Execute
        </button>
        <button
          type="button"
          onClick={() => void onExecute(script.id, ['device-1', 'device-2'], {}, 'system')}
        >
          Confirm Execute Multi
        </button>
      </>
    ) : null
}));

vi.mock('./ExecutionDetails', () => ({
  default: () => null
}));


const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseScript = {
  id: 'script-1',
  name: 'Cleanup Temp Files',
  language: 'bash',
  category: 'maintenance',
  osTypes: ['linux'],
  createdAt: '2026-02-09T10:00:00.000Z',
  updatedAt: '2026-02-09T10:00:00.000Z'
};

describe('ScriptsPage admission refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes script history after at least one target is admitted', async () => {
    let scriptsFetchCount = 0;
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) {
        scriptsFetchCount += 1;
        return makeJsonResponse({ data: [baseScript] });
      }
      if (url === '/devices') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/orgs/sites') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/scripts/script-1') {
        return makeJsonResponse(baseScript);
      }
      if (url === '/scripts/script-1/execute') {
        return makeJsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: 'device-1', admission: 'admitted', executionId: 'execution-1' }],
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);

    await screen.findByText('Run Cleanup Temp Files');
    expect(fetchWithAuthMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => expect(scriptsFetchCount).toBeGreaterThanOrEqual(2));
  });

  it('does not refresh script history when the valid admission rejects every target', async () => {
    let scriptsFetchCount = 0;

    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) {
        scriptsFetchCount += 1;
        return makeJsonResponse({ data: [baseScript] });
      }
      if (url === '/devices') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/orgs/sites') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/scripts/script-1') {
        return makeJsonResponse(baseScript);
      }
      if (url === '/scripts/script-1/execute') {
        return makeJsonResponse({
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'rejected',
          targets: [{ requestedDeviceId: 'device-1', admission: 'suppressed', reasonCode: 'maintenance_suppressed' }],
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);

    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url) === '/scripts/script-1/execute')).toBe(true));
    expect(scriptsFetchCount).toBe(1);
  });
});

describe('ScriptsPage duplicate action (#4887)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clones the script and navigates to the new script on success', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) {
        return makeJsonResponse({ data: [baseScript] });
      }
      if (url === '/orgs/sites') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/scripts/script-1/clone' && init?.method === 'POST') {
        return makeJsonResponse({ id: 'script-2', name: 'Cleanup Temp Files (copy)' }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);

    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Duplicate Cleanup Temp Files'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/scripts/script-2'));
  });

  it('does not navigate, and shows an error toast, when the clone request fails', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) {
        return makeJsonResponse({ data: [baseScript] });
      }
      if (url === '/orgs/sites') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/scripts/script-1/clone' && init?.method === 'POST') {
        return makeJsonResponse({ error: 'Script not found' }, false, 404);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);

    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Duplicate Cleanup Temp Files'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalled();
  });
});

// #4886 — running a script from the library must land the operator where the
// result appears, instead of leaving them on the (now stale) scripts list.
describe('ScriptsPage post-run navigation (#4886)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates to the device Scripts tab, highlighting the new execution, for a single-device run', async () => {
    const { navigateTo } = await import('@/lib/navigation');
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) return makeJsonResponse({ data: [baseScript] });
      if (url === '/orgs/sites') return makeJsonResponse({ data: [] });
      if (url === '/scripts/script-1') return makeJsonResponse(baseScript);
      if (url === '/scripts/script-1/execute') {
        return makeJsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [{ requestedDeviceId: 'device-1', admission: 'admitted', executionId: 'execution-1' }],
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);
    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/devices/device-1#scripts/execution-1'));
  });

  it('navigates to the script execution-history page for a multi-device run', async () => {
    const { navigateTo } = await import('@/lib/navigation');
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) return makeJsonResponse({ data: [baseScript] });
      if (url === '/orgs/sites') return makeJsonResponse({ data: [] });
      if (url === '/scripts/script-1') return makeJsonResponse(baseScript);
      if (url === '/scripts/script-1/execute') {
        return makeJsonResponse({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'queued',
          targets: [
            { requestedDeviceId: 'device-1', admission: 'admitted', executionId: 'execution-1' },
            { requestedDeviceId: 'device-2', admission: 'admitted', executionId: 'execution-2' },
          ],
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);
    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute Multi'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/scripts/script-1/executions'));
  });

  it('does not navigate when every target was rejected', async () => {
    const { navigateTo } = await import('@/lib/navigation');
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) return makeJsonResponse({ data: [baseScript] });
      if (url === '/orgs/sites') return makeJsonResponse({ data: [] });
      if (url === '/scripts/script-1') return makeJsonResponse(baseScript);
      if (url === '/scripts/script-1/execute') {
        return makeJsonResponse({
          requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          status: 'rejected',
          targets: [{ requestedDeviceId: 'device-1', admission: 'suppressed', reasonCode: 'maintenance_suppressed' }],
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);
    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => expect(fetchWithAuthMock.mock.calls.some(([url]) => String(url) === '/scripts/script-1/execute')).toBe(true));
    expect(navigateTo).not.toHaveBeenCalled();
  });
});
