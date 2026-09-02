import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';
import type { ScriptAdmissionResult } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ currentOrgId: null, organizations: [] }), {
    getState: () => ({ currentOrgId: null, organizations: [] })
  })
}));

vi.mock('./ScriptList', () => ({
  default: ({ scripts, onRun }: { scripts: Array<{ id: string; name: string; lastRun?: string }>; onRun?: (script: { id: string; name: string; lastRun?: string }) => void }) => (
    <div>
      {scripts.map(script => (
        <div key={script.id}>
          <span data-testid={`last-run-${script.id}`}>{script.lastRun ?? 'Never'}</span>
          <button type="button" onClick={() => onRun?.(script)}>
            Run {script.name}
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
      <button
        type="button"
        onClick={() => void onExecute(script.id, ['device-1'], {}, 'system')}
      >
        Confirm Execute
      </button>
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
