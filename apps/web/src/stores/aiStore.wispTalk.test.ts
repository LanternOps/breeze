import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn(), activeThreadFor: vi.fn(), addWispLink: vi.fn(), showToast: vi.fn() }));
vi.mock('./auth', () => ({ fetchWithAuth: h.fetch }));
vi.mock('./orgStore', () => ({ useOrgStore: { getState: () => ({ currentOrgId: 'org-b', organizations: [{ id: 'org-a', name: 'Organization A' }, { id: 'org-b', name: 'Organization B' }] }) } }));
vi.mock('@/lib/wispTalk', () => ({ activeThreadFor: h.activeThreadFor }));
vi.mock('@/lib/wispLinksApi', () => ({ addWispLink: h.addWispLink }));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));

import { useAiStore, type WispState } from './aiStore';
import { runLogoutHooks } from './logoutHooks';

const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const grant = (over: Partial<NonNullable<WispState>> = {}): NonNullable<WispState> => ({
  threadId: 'thread-1', grantId: 'grant-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null,
  status: 'active', expiresAt: '2027-01-01T00:00:00Z', summary: '', budgetCentsPerDay: 200,
  floorTickMinutes: 30, wideningAvailable: false, ...over,
});
const target = { kind: 'ticket' as const, id: 'ticket-1', orgId: 'org-b', label: 'Printer repair' };
const mutationCalls = () => h.fetch.mock.calls.filter(([, init]) => ['POST', 'PATCH', 'DELETE'].includes(init?.method));

beforeEach(() => {
  vi.clearAllMocks();
  useAiStore.setState(useAiStore.getInitialState(), true);
  h.activeThreadFor.mockResolvedValue(grant());
  h.addWispLink.mockResolvedValue({ id: 'link-1' });
  h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/ai/sessions' && init?.method === 'POST') return response({ id: 'session-new', orgId: 'org-b' });
    if (url.endsWith('/focus')) return response({ data: { focusOrgId: 'org-b', focusOrgName: 'Organization B' } });
    return response({ data: [] });
  });
});

describe('talkToWispAbout', () => {
  it('with a grant opens Wisp, pins, prefills and requests composer focus, without sending', async () => {
    expect(await useAiStore.getState().talkToWispAbout(target)).toBe('opened');
    expect(h.addWispLink).toHaveBeenCalledWith('thread-1', { kind: target.kind, id: target.id, orgId: target.orgId });
    expect(useAiStore.getState()).toMatchObject({ isOpen: true, composerDraft: 'About Printer repair: ', composerFocusRequest: 1, wisp: { grantId: 'grant-1' } });
    expect(mutationCalls().map(([url]) => url)).toEqual(['/ai/sessions']);
  });

  it('keeps an existing draft, including text typed while pinning', async () => {
    h.addWispLink.mockImplementation(async () => { useAiStore.getState().setComposerDraft('Existing draft'); return { id: 'link-1' }; });
    await useAiStore.getState().talkToWispAbout(target);
    expect(useAiStore.getState().composerDraft).toBe('Existing draft');
  });

  it('asks inline before switching focus and stops on no', async () => {
    useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a', focusOrgName: 'Organization A' }), sessionId: 'session-old' });
    const pending = useAiStore.getState().talkToWispAbout(target);
    await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
    expect(useAiStore.getState().wispTalkFocusRequest).toMatchObject({ target, from: 'Organization A', to: 'Organization B' });
    useAiStore.getState().resolveWispTalkFocus(false);
    expect(await pending).toBe('declined_focus');
    expect(h.addWispLink).not.toHaveBeenCalled();
    expect(mutationCalls()).toHaveLength(0);
    expect(useAiStore.getState()).toMatchObject({ isOpen: false, composerDraft: '', sessionId: 'session-old', wispTalkFocusRequest: null });
  });

  it('switches focus on yes before pinning', async () => {
    useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a', focusOrgName: 'Organization A' }), sessionId: 'session-old' });
    const pending = useAiStore.getState().talkToWispAbout(target);
    await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
    useAiStore.getState().resolveWispTalkFocus(true);
    expect(await pending).toBe('opened');
    expect(h.fetch).toHaveBeenCalledWith('/wisp/thread/thread-1/focus', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ orgId: 'org-b' }) }));
    expect(h.addWispLink).toHaveBeenCalledTimes(1);
    expect(useAiStore.getState().wisp?.focusOrgId).toBe('org-b');
  });

  it('a refused focus switch cannot pin or fill the draft', async () => {
    useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a' }), sessionId: 'session-old' });
    h.fetch.mockResolvedValue(response({ error: 'Outside ceiling', code: 'outside_ceiling' }, 403));
    const pending = useAiStore.getState().talkToWispAbout(target);
    await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
    useAiStore.getState().resolveWispTalkFocus(true);
    expect(await pending).toBe('declined_focus');
    expect(h.addWispLink).not.toHaveBeenCalled();
    expect(useAiStore.getState().composerDraft).toBe('');
  });

  it('a concurrent thread change while confirmation is open cancels the action', async () => {
    useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a' }), sessionId: 'session-old' });
    const pending = useAiStore.getState().talkToWispAbout(target);
    await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
    useAiStore.setState({ wisp: grant({ threadId: 'thread-other' }) });
    useAiStore.getState().resolveWispTalkFocus(true);
    expect(await pending).toBe('declined_focus');
    expect(h.addWispLink).not.toHaveBeenCalled();
  });

  it('without a grant opens plain chat only after creating its session', async () => {
    h.activeThreadFor.mockResolvedValue(null);
    h.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/ai/sessions' && init?.method === 'POST') {
        expect(useAiStore.getState().isOpen).toBe(false);
        expect(JSON.parse(String(init.body))).not.toHaveProperty('wispGrantId');
        return response({ id: 'session-plain', orgId: 'org-b' });
      }
      return response({ data: [] });
    });
    expect(await useAiStore.getState().talkToWispAbout(target)).toBe('no_grant');
    expect(useAiStore.getState()).toMatchObject({ isOpen: true, wisp: null, sessionId: 'session-plain', composerDraft: 'About Printer repair: ' });
    expect(h.addWispLink).not.toHaveBeenCalled();
  });

  it('does not pin or report success after a refused Wisp session create', async () => {
    h.fetch.mockResolvedValue(response({ error: 'Grant inactive', code: 'grant_inactive' }, 409));
    await expect(useAiStore.getState().talkToWispAbout(target)).rejects.toThrow('Grant inactive');
    expect(h.addWispLink).not.toHaveBeenCalled();
    expect(useAiStore.getState().composerDraft).toBe('');
  });

  it('does not overwrite another session after pin returns', async () => {
    h.addWispLink.mockImplementation(async () => { useAiStore.setState({ sessionId: 'session-other' }); return { id: 'link-1' }; });
    expect(await useAiStore.getState().talkToWispAbout(target)).toBe('declined_focus');
    expect(useAiStore.getState().composerDraft).toBe('');
  });
});


it('a discovered focused grant asks before creating a session, then creates only the new focus session', async () => {
  h.activeThreadFor.mockResolvedValue(grant({ focusOrgId: 'org-a', focusOrgName: 'Organization A' }));
  const pending = useAiStore.getState().talkToWispAbout(target);
  await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
  expect(mutationCalls()).toHaveLength(0);
  useAiStore.getState().resolveWispTalkFocus(true);
  expect(await pending).toBe('opened');
  const creates = h.fetch.mock.calls.filter(([url, init]) => url === '/ai/sessions' && init?.method === 'POST');
  expect(creates).toHaveLength(1);
  expect(JSON.parse(creates[0][1].body)).toMatchObject({ orgId: 'org-b', wispGrantId: 'grant-1' });
});

it('a newer request cancels an older confirmation instead of leaving it pending', async () => {
  useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a' }), sessionId: 'session-old' });
  const first = useAiStore.getState().talkToWispAbout(target);
  await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
  const second = useAiStore.getState().talkToWispAbout({ ...target, id: 'ticket-2' });
  await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest?.target.id).toBe('ticket-2'));
  expect(await first).toBe('declined_focus');
  useAiStore.getState().resolveWispTalkFocus(false);
  expect(await second).toBe('declined_focus');
  expect(h.addWispLink).not.toHaveBeenCalled();
});

it('does not reuse another organization-scoped grant for this record', async () => {
  useAiStore.setState({ wisp: grant({ scopeOrgId: 'org-a' }), sessionId: 'session-old' });
  h.activeThreadFor.mockResolvedValue(grant({ grantId: 'grant-record', threadId: 'thread-record', scopeOrgId: 'org-b' }));
  expect(await useAiStore.getState().talkToWispAbout(target)).toBe('opened');
  expect(h.activeThreadFor).toHaveBeenCalledWith('org-b');
  expect(h.addWispLink).toHaveBeenCalledWith('thread-record', expect.objectContaining({ id: 'ticket-1' }));
});

it('a failed grant lookup never opens a plain fallback', async () => {
  h.activeThreadFor.mockRejectedValue(new Error('network'));
  await expect(useAiStore.getState().talkToWispAbout(target)).rejects.toThrow('network');
  expect(mutationCalls()).toHaveLength(0);
  expect(useAiStore.getState().isOpen).toBe(false);
});

it('a refused pin propagates to the caller and never fills or focuses the composer', async () => {
  h.addWispLink.mockRejectedValue(new Error('Pin limit'));
  await expect(useAiStore.getState().talkToWispAbout(target)).rejects.toThrow('Pin limit');
  expect(useAiStore.getState()).toMatchObject({ composerDraft: '', composerFocusRequest: 0 });
});


it('direct unmount cancellation clears its own request', async () => {
  useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a' }), sessionId: 'session-old' });
  const pending = useAiStore.getState().talkToWispAbout(target);
  await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
  useAiStore.getState().wispTalkFocusRequest?.resolve(false);
  expect(await pending).toBe('declined_focus');
  expect(useAiStore.getState().wispTalkFocusRequest).toBeNull();
});

it('plain fallback replaces an older session whose grant header may still be rehydrating', async () => {
  h.activeThreadFor.mockResolvedValue(null);
  useAiStore.setState({ sessionId: 'restored-session', sessionOrgId: 'org-a', hydratedSessionId: null });
  expect(await useAiStore.getState().talkToWispAbout(target)).toBe('no_grant');
  expect(useAiStore.getState()).toMatchObject({ sessionId: 'session-new', wisp: null, isOpen: true });
  const creates = h.fetch.mock.calls.filter(([url, init]) => url === '/ai/sessions' && init?.method === 'POST');
  expect(creates).toHaveLength(1);
  expect(JSON.parse(creates[0][1].body)).toMatchObject({ orgId: 'org-b' });
  expect(JSON.parse(creates[0][1].body)).not.toHaveProperty('wispGrantId');
});


it('logout cancels a pending confirmation before resetting the store', async () => {
  useAiStore.setState({ wisp: grant({ focusOrgId: 'org-a' }), sessionId: 'session-old' });
  const pending = useAiStore.getState().talkToWispAbout(target);
  await vi.waitFor(() => expect(useAiStore.getState().wispTalkFocusRequest).not.toBeNull());
  runLogoutHooks();
  expect(await pending).toBe('declined_focus');
  expect(useAiStore.getState()).toMatchObject({ wispTalkFocusRequest: null, wisp: null, sessionId: null, composerDraft: '' });
  expect(h.addWispLink).not.toHaveBeenCalled();
});


it('a refused plain create cannot reuse an older session and report success', async () => {
  h.activeThreadFor.mockResolvedValue(null);
  useAiStore.setState({ sessionId: 'restored-session', sessionOrgId: 'org-a' });
  h.fetch.mockResolvedValue(response({ error: 'Could not create chat' }, 403));
  await expect(useAiStore.getState().talkToWispAbout(target)).rejects.toThrow('Could not create chat');
  expect(useAiStore.getState()).toMatchObject({ sessionId: null, isOpen: false, composerDraft: '' });
});
