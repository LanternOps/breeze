/**
 * #9840 lab row F1: signing out must leave the side panel unbound.
 *
 * Sign-out navigates to /login without a page load, so the panel store keeps
 * its memory. auth.ts removes `breeze-ai-chat` from storage, but unless the
 * store itself is reset, the next persist write puts the old session id back
 * and the next person to sign in on that browser sees the previous user's
 * conversation, rendered from memory without a request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: null }) } }));

import { useAiStore } from './aiStore';
import { runLogoutHooks } from './logoutHooks';

const SESSION = '42ad4512-c801-47a5-8b82-28f3e23c4e27';
const ORG = 'aaaaaaaa-1111-4222-8333-444455556666';

describe('aiStore at logout', () => {
  beforeEach(() => {
    localStorage.clear();
    useAiStore.setState({
      isOpen: true,
      sessionId: SESSION,
      sessionOrgId: ORG,
      hydratedSessionId: SESSION,
      messages: [{ id: 'm1', role: 'user', content: 'previous user question', createdAt: new Date() }] as never,
      sessions: [{ id: SESSION, title: 'previous user conversation', status: 'active', createdAt: '2026-10-26' }],
      showHistory: true,
      composerDraft: 'half-typed text',
      isStreaming: true,
      error: 'old error',
    });
  });

  it('clears the bound conversation, its messages, the history list and the draft', () => {
    runLogoutHooks();
    const s = useAiStore.getState();
    expect(s.sessionId).toBeNull();
    expect(s.sessionOrgId).toBeNull();
    expect(s.hydratedSessionId).toBeNull();
    expect(s.messages).toEqual([]);
    expect(s.sessions).toEqual([]);
    expect(s.showHistory).toBe(false);
    expect(s.composerDraft).toBe('');
    expect(s.isStreaming).toBe(false);
    expect(s.isOpen).toBe(false);
    expect(s.error).toBeNull();
  });

  it('leaves nothing for persist to write back once storage is cleared', () => {
    runLogoutHooks();
    localStorage.removeItem('breeze-ai-chat'); // what evictLocalAuthState does next
    useAiStore.setState({ isOpen: true }); // any later write, e.g. the next sign-in opening the panel
    const raw = localStorage.getItem('breeze-ai-chat');
    expect(raw === null || JSON.parse(raw).state.sessionId === null).toBe(true);
  });

  it('keeps the store usable after the reset', () => {
    runLogoutHooks();
    expect(typeof useAiStore.getState().toggle).toBe('function');
    useAiStore.getState().toggle();
    expect(useAiStore.getState().isOpen).toBe(true);
  });
});
