import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import ScriptsPage from './ScriptsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ user: null, tokens: null }),
    { getState: () => ({ user: null, tokens: null }) }
  )
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(() => ({ currentOrgId: null, organizations: [] }), {
    getState: () => ({ currentOrgId: null, organizations: [] })
  })
}));
vi.mock('./ScriptList', () => ({
  default: ({ scripts, onRun }: { scripts: Array<{ id: string; name: string }>; onRun?: (s: { id: string; name: string }) => void }) => (
    <div>
      {scripts.map(s => (
        <button key={s.id} type="button" onClick={() => onRun?.(s)}>Run {s.name}</button>
      ))}
    </div>
  )
}));
vi.mock('./ExecutionDetails', () => ({ default: () => null }));

// Stateful stand-in for the real modal: like ScriptExecutionModal it keeps the
// admission result in its OWN state, so a parent that unmounts/remounts it
// (the loading swap) loses the result and falls back to the blank picker.
vi.mock('./ScriptExecutionModal', () => ({
  default: ({ isOpen, onExecute, script }: {
    isOpen: boolean;
    onExecute: (id: string, target: string[], p: Record<string, never>, runAs: 'system') => Promise<{ targets: Array<{ requestedDeviceId: string; admission: string; reasonCode?: string }> }>;
    script: { id: string };
  }) => {
    const [result, setResult] = useState<Array<{ requestedDeviceId: string; reasonCode?: string }> | null>(null);
    if (!isOpen) return null;
    if (result) {
      return (
        <ul data-testid="admission-result">
          {result.map(t => <li key={t.requestedDeviceId}>{t.requestedDeviceId}:{t.reasonCode}</li>)}
        </ul>
      );
    }
    return (
      <button type="button" onClick={async () => setResult((await onExecute(script.id, ['win', 'mac'], {}, 'system')).targets)}>
        Confirm Execute
      </button>
    );
  }
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: 'x', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const script = {
  id: 'script-1', name: 'Win Only', language: 'powershell', category: 'maintenance',
  osTypes: ['windows'], createdAt: '2026-02-09T10:00:00.000Z', updatedAt: '2026-02-09T10:00:00.000Z'
};

describe('ScriptsPage partial admission (#8670 sweep)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the modal and its per-device admission result mounted after the list refresh', async () => {
    let scriptsFetches = 0;
    fetchWithAuthMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/scripts?')) {
        scriptsFetches += 1;
        // Real network latency: without it React batches loading true->false
        // into one render and the remount never happens.
        if (scriptsFetches > 1) await new Promise(r => setTimeout(r, 30));
        return json({ data: [script] });
      }
      if (url === '/orgs/sites') return json({ data: [] });
      if (url === '/scripts/script-1/execute') {
        return json({
          requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          status: 'partially_queued',
          targets: [
            { requestedDeviceId: 'win', admission: 'admitted', executionId: 'e1', reasonCode: 'queued_offline' },
            { requestedDeviceId: 'mac', admission: 'excluded', reasonCode: 'os_incompatible' },
          ],
        }, true, 201);
      }
      return json({}, false, 404);
    });

    render(<ScriptsPage />);
    fireEvent.click(await screen.findByText('Run Win Only'));
    fireEvent.click(await screen.findByText('Confirm Execute'));

    await waitFor(() => expect(scriptsFetches).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('mac:os_incompatible')).toBeTruthy();
    expect(screen.getByTestId('admission-result')).toBeTruthy();
    expect(screen.queryByText('Confirm Execute')).toBeNull();
  });
});
