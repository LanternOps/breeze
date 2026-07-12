import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from './auth';
import { useOrgStore } from './orgStore';
import { useAiStore } from './aiStore';
import { runSessionTeardown } from './sessionTeardown';

function authenticateForRequestTests() {
  useAuthStore.getState().login(
    { id: 'user-a', email: 'a@example.com', name: 'A', role: 'admin' } as never,
    { accessToken: 'access-a', expiresInSeconds: 3600 } as never,
  );
}

beforeEach(() => authenticateForRequestTests());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('web session generation fencing', () => {
  it('drops an old org response after teardown and preserves account B state and persistence', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const oldLoad = useOrgStore.getState().fetchPartners();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    runSessionTeardown();
    useOrgStore.setState({
      currentPartnerId: 'partner-b', partners: [{ id: 'partner-b', name: 'B', status: 'active', createdAt: 'now' }],
      isLoading: false, error: null,
    });
    resolveFetch(new Response(JSON.stringify([{ id: 'partner-a', name: 'A', status: 'active', createdAt: 'now' }]), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await oldLoad;

    expect(useOrgStore.getState().currentPartnerId).toBe('partner-b');
    expect(useOrgStore.getState().partners.map((partner) => partner.id)).toEqual(['partner-b']);
    expect(localStorage.getItem('breeze-org')).toContain('partner-b');
  });

  it('drops an old AI initial response after teardown and preserves account B session', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const oldCreate = useAiStore.getState().createSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());

    runSessionTeardown();
    useAiStore.setState({ sessionId: 'session-b', messages: [], isLoading: false, error: null });
    resolveFetch(new Response(JSON.stringify({ id: 'session-a' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await oldCreate;

    expect(useAiStore.getState().sessionId).toBe('session-b');
    expect(localStorage.getItem('breeze-ai-chat')).toContain('session-b');
  });

  it('drops an old stream event and catches a rejected cancel without an unhandled rejection', async () => {
    let resolveRead!: (result: { done: boolean; value: Uint8Array }) => void;
    const read = vi.fn(() => new Promise<{ done: boolean; value: Uint8Array }>((resolve) => { resolveRead = resolve; }));
    const cancelError = new Error('cancel rejected');
    const cancel = vi.fn().mockRejectedValue(cancelError);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      clone: () => ({ json: async () => ({}) }),
      body: { getReader: () => ({ read, cancel }) },
    }));
    useAiStore.setState({ sessionId: 'session-a', messages: [], isLoading: false, isStreaming: false });
    const oldSend = useAiStore.getState().sendMessage('old request');
    await vi.waitFor(() => expect(read).toHaveBeenCalled());

    runSessionTeardown();
    useAiStore.setState({
      sessionId: 'session-b', messages: [{ id: 'message-b', role: 'user', content: 'B', createdAt: new Date() }] as never,
      isStreaming: false, isLoading: false, error: null,
    });
    const encoded = new TextEncoder().encode('data: {"type":"text_delta","content":"old"}\n');
    resolveRead({ done: false, value: encoded });
    await oldSend;
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[AI] Failed to cancel an active response during session teardown:', cancelError,
    ));

    expect(cancel).toHaveBeenCalledOnce();
    expect(useAiStore.getState().sessionId).toBe('session-b');
    expect(useAiStore.getState().messages).toHaveLength(1);
    expect(useAiStore.getState().messages[0]?.id).toBe('message-b');
  });
});
