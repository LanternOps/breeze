import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
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
    onExecute: (scriptId: string, deviceIds: string[], parameters: Record<string, string | number | boolean>, runAs: 'system' | 'user') => Promise<void>;
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

describe('ScriptsPage execution freshness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates lastRun from execution response timestamp when available', async () => {
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/scripts') {
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
          executions: [{ createdAt: '2026-02-09T15:30:00.000Z' }]
        }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);

    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => {
      expect(screen.getByTestId('last-run-script-1').textContent).toBe('2026-02-09T15:30:00.000Z');
    });

    const scriptsCalls = fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === '/scripts');
    expect(scriptsCalls).toHaveLength(1);
  });

  it('refetches scripts when execution response has no timestamp', async () => {
    let scriptsFetchCount = 0;

    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/scripts') {
        scriptsFetchCount += 1;
        if (scriptsFetchCount === 1) {
          return makeJsonResponse({ data: [baseScript] });
        }
        return makeJsonResponse({
          data: [{ ...baseScript, lastRun: '2026-02-09T16:45:00.000Z' }]
        });
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
        return makeJsonResponse({ status: 'queued' }, true, 201);
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<ScriptsPage />);

    await screen.findByText('Run Cleanup Temp Files');
    fireEvent.click(screen.getByText('Run Cleanup Temp Files'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => {
      expect(screen.getByTestId('last-run-script-1').textContent).toBe('2026-02-09T16:45:00.000Z');
    });

    const scriptsCalls = fetchWithAuthMock.mock.calls.filter(([url]) => String(url) === '/scripts');
    expect(scriptsCalls.length).toBeGreaterThanOrEqual(2);
  });
});
