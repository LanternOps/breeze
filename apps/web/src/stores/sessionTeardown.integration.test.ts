import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearLocalAuthSession, useAuthStore } from './auth';
import { useOrgStore } from './orgStore';
import { useAiStore } from './aiStore';
import { useWorkspaceStore } from './workspaceStore';
import { registerSessionTeardown } from './sessionTeardown';

afterEach(() => vi.unstubAllGlobals());

describe('terminal cross-store session teardown', () => {
  it('attempts every memory, persistence, and cancellation cleanup despite individual failures', async () => {
    useAuthStore.getState().login(
      { id: 'user-old', email: 'old@example.com', name: 'Old', role: 'admin' } as never,
      { accessToken: 'old-access', expiresInSeconds: 3600 } as never,
    );
    useOrgStore.setState({
      currentPartnerId: 'partner-old', currentOrgId: 'org-old', currentSiteId: 'site-old',
      allOrgs: true, lastOrgId: 'org-last',
      partners: [{ id: 'partner-old', name: 'Old', status: 'active', createdAt: 'now' }],
      organizations: [{ id: 'org-old', partnerId: 'partner-old', name: 'Old', status: 'active', createdAt: 'now' }],
      sites: [{ id: 'site-old', orgId: 'org-old', name: 'Old', deviceCount: 1, createdAt: 'now' }],
      isLoading: true, error: 'old error',
    });
    useAiStore.setState({
      isOpen: true, sessionId: 'ai-old', messages: [{ id: 'm-old' }] as never,
      isStreaming: false, isLoading: false, error: null, pendingApproval: { id: 'approval-old' } as never,
      sessions: [{ id: 'ai-old', title: 'Old', status: 'active', createdAt: 'now' }],
      m365Connections: [{ id: 'conn-old', customerLabel: 'Old', customerDisplayName: 'Old' }],
      selectedM365ConnectionId: 'conn-old', boundM365ConnectionId: 'conn-old',
    });

    let finishRead!: () => void;
    const aiCancel = vi.fn().mockImplementation(() => { finishRead(); return Promise.resolve(); });
    const aiRead = vi.fn().mockImplementation(() => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
      finishRead = () => resolve({ done: true });
    }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      clone: () => ({ json: async () => ({}) }),
      body: { getReader: () => ({ read: aiRead, cancel: aiCancel }) },
    }));
    const aiSend = useAiStore.getState().sendMessage('old request');
    for (let attempt = 0; attempt < 20 && aiRead.mock.calls.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(aiRead, useAiStore.getState().error ?? 'AI reader was not started').toHaveBeenCalled();
    useAiStore.setState({ isLoading: true, error: 'old error' });

    const workspaceCancel = vi.fn().mockResolvedValue(undefined);
    useWorkspaceStore.setState({
      tabs: [{ id: 'old-tab' }] as never, activeTabId: 'old-tab',
      _readers: new Map([['old-stream', { cancel: workspaceCancel } as never]]),
    });
    for (const key of ['breeze-auth', 'breeze-org', 'breeze-ai-chat', 'breeze-workspace']) {
      localStorage.setItem(key, JSON.stringify({ stale: key }));
    }
    const throwingCallback = vi.fn(() => { throw new Error('injected callback failure'); });
    const unregister = registerSessionTeardown(throwingCallback);
    const removed: string[] = [];
    const storage = {
      removeItem(key: string) {
        removed.push(key);
        localStorage.removeItem(key);
        if (key === 'breeze-org') throw new Error('injected storage failure');
      },
    };

    try {
      clearLocalAuthSession(storage, storage);
      await aiSend;
      expect(throwingCallback).toHaveBeenCalledOnce();
      expect(aiCancel).toHaveBeenCalledOnce();
      expect(workspaceCancel).toHaveBeenCalledOnce();
      expect(removed).toEqual(expect.arrayContaining([
        'breeze-auth', 'breeze-org', 'breeze-ai-chat', 'breeze-workspace', 'breeze-mfa-enrollment-methods',
      ]));
      expect(useOrgStore.getState()).toMatchObject({
        currentPartnerId: null, currentOrgId: null, currentSiteId: null,
        partners: [], organizations: [], sites: [], isLoading: false, error: null,
      });
      expect(useAiStore.getState()).toMatchObject({
        isOpen: false, sessionId: null, messages: [], isStreaming: false, isLoading: false,
        pendingApproval: null, sessions: [], m365Connections: [], selectedM365ConnectionId: null,
      });
      expect(useWorkspaceStore.getState()).toMatchObject({ tabs: [], activeTabId: null });
      expect(useWorkspaceStore.getState()._readers.size).toBe(0);

      await Promise.all([
        useOrgStore.persist.rehydrate(), useAiStore.persist.rehydrate(), useWorkspaceStore.persist.rehydrate(),
      ]);
      expect(useOrgStore.getState().currentOrgId).toBeNull();
      expect(useAiStore.getState().sessionId).toBeNull();
      expect(useWorkspaceStore.getState().tabs).toEqual([]);
    } finally {
      unregister();
    }
  });
});
