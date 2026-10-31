import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '@/lib/runAction';

const h = vi.hoisted(() => ({
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p1', orgId: null } } as Record<string, unknown>,
  server: true, entitlement: 'enabled', wisp: null as null | Record<string, unknown>,
  request: null as null | Record<string, unknown>,
  talk: vi.fn(), plain: vi.fn(), resolveFocus: vi.fn(), fetch: vi.fn(), toast: vi.fn(),
  visibilityOpts: undefined as undefined | { enabled?: boolean },
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));
vi.mock('@/lib/wispVisibility', () => ({ useWispEnabled: (opts?: { enabled?: boolean }) => { h.visibilityOpts = opts; return h.server; } }));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => ({ state: h.entitlement }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: (sel: (s: unknown) => unknown) => sel({
  wisp: h.wisp, talkToWispAbout: h.talk, openPlainChatAbout: h.plain,
  wispTalkFocusRequest: h.request, resolveWispTalkFocus: h.resolveFocus,
}) }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: h.fetch }));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.toast }));

import WispTalkButton from './WispTalkButton';
import { resetWispTalkTargetCache } from '@/lib/wispTalk';
const target = { kind: 'ticket' as const, id: 't1', orgId: 'o1', label: 'Printer' };
const res = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
const threadBody = (threadId = 'th1', status = 'active') => ({ data: {
  thread: { id: threadId, focusOrgId: null, summary: '' },
  grant: { id: 'g1', status, orgId: null, expiresAt: '2099-01-01T00:00:00Z' },
} });

describe('WispTalkButton', () => {
  beforeEach(() => {
    vi.clearAllMocks(); resetWispTalkTargetCache();
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p1', orgId: null } };
    h.server = true; h.entitlement = 'enabled'; h.wisp = null; h.request = null;
    h.fetch.mockResolvedValue(res(200, threadBody())); h.talk.mockResolvedValue('opened'); h.plain.mockResolvedValue(undefined);
  });
  it.each([
    ['flag off', () => { h.server = false; }],
    ['org token', () => { h.claims = { status: 'resolved', claims: { scope: 'organization' } }; }],
    ['not entitled', () => { h.entitlement = 'locked'; }],
  ])('keeps eligibility gates and opens plain AI when %s', async (_why, arrange) => {
    arrange(); render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.plain).toHaveBeenCalledWith(target));
    expect(h.fetch).not.toHaveBeenCalled(); expect(h.talk).not.toHaveBeenCalled();
  });
  it('uses the active store thread without a lookup and delegates the target including label', async () => {
    h.wisp = { threadId: 'store', grantId: 'g1', status: 'active' };
    render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.talk).toHaveBeenCalledWith(target));
    expect(h.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('wisp-talk-button')).not.toBeDisabled();
  });
  it('without a grant falls through partner then record org and opens plain chat', async () => {
    h.fetch.mockResolvedValue(res(200, { data: null }));
    render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.plain).toHaveBeenCalledWith(target));
    expect(h.fetch).toHaveBeenNthCalledWith(1, '/wisp/thread', { skipOrgIdInjection: true });
    expect(h.fetch).toHaveBeenNthCalledWith(2, '/wisp/thread?orgId=o1', { skipOrgIdInjection: true });
  });
  it('a paused store grant uses the active lookup', async () => {
    h.wisp = { threadId: 'paused', status: 'paused' };
    render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.talk).toHaveBeenCalled());
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('one lookup per org per page is shared by the buttons', async () => {
    render(<><WispTalkButton {...target} /><WispTalkButton {...target} id="t2" /></>);
    await waitFor(() => expect(screen.getAllByTestId('wisp-talk-button')).toHaveLength(2));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it('a paused partner grant falls through to the record org grant', async () => {
    h.fetch.mockResolvedValueOnce(res(200, threadBody('paused', 'paused'))).mockResolvedValueOnce(res(200, threadBody('org')));
    render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.talk).toHaveBeenCalled());
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it('failed lookups are evicted and retry on the next mount', async () => {
    h.fetch.mockRejectedValueOnce(new Error('network'));
    const first = render(<WispTalkButton {...target} />);
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1)); first.unmount();
    render(<WispTalkButton {...target} />);
    expect(await screen.findByTestId('wisp-talk-button')).toBeInTheDocument();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403])('ActionError %s is already handled and leaves the button usable', async (status) => {
    h.talk.mockRejectedValue(new ActionError('Refused', status));
    render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.talk).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('wisp-talk-button')).not.toBeDisabled());
    expect(h.toast).not.toHaveBeenCalled();
  });
  it('other action failures toast once', async () => {
    h.talk.mockRejectedValue(new Error('network'));
    render(<WispTalkButton {...target} />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });
  it('renders an inline focus choice and resolves no without a browser dialog', async () => {
    let finish!: (value: string) => void;
    h.talk.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<WispTalkButton {...target} size="sm" />);
    fireEvent.click(await screen.findByTestId('wisp-talk-button'));
    h.request = { target, from: 'Organization A', to: 'Organization B', resolve: vi.fn() };
    view.rerender(<WispTalkButton {...target} size="sm" />);
    expect(screen.getByTestId('wisp-talk-focus-popover')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('wisp-talk-focus-no'));
    expect(h.resolveFocus).toHaveBeenCalledWith(false);
    finish('declined_focus');
    expect(screen.getByTestId('wisp-talk-button')).toHaveClass('text-xs');
  });
  it('asks server flag only for partner tokens', () => {
    h.claims = { status: 'resolved', claims: { scope: 'organization' } };
    render(<WispTalkButton {...target} />); expect(h.visibilityOpts).toEqual({ enabled: false });
  });
});
