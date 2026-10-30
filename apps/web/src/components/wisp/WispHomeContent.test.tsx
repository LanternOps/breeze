/**
 * The Wisp home from a mocked GET /wisp/home. W08 (#9921) Task 9: no grant
 * (start card), not entitled (FeatureLock), partner switch off (explanation,
 * no start button), polling, stale and revoke. W01 (#10211) Task 12: the ready
 * state is the companion layout (thread column + rail, a strip below `lg`)
 * with no page heading; the other states keep the framed heading.
 */
import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Concern, ConcernStatus, WispHomePayload } from '@breeze/shared';

const h = vi.hoisted(() => ({
  entitlement: { state: 'enabled', failed: false, reload: vi.fn() } as Record<string, unknown>,
  fetchWispHome: vi.fn(),
  fetchWispPartnerEnabled: vi.fn(),
  wide: true,
  organizations: [] as Array<{ id: string; name: string }>,
  modalProps: null as null | Record<string, unknown>,
  threadProps: null as null | Record<string, unknown>,
  railProps: null as null | Record<string, unknown>,
  store: { wisp: null as null | Record<string, unknown>, updateWisp: vi.fn(), exitWispMode: vi.fn() },
}));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => h.entitlement }));
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => h.wide }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: h.organizations, currentOrgId: null }),
}));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) => sel(h.store),
}));
vi.mock('./wispHome', async (orig) => ({
  ...(await orig<typeof import('./wispHome')>()),
  fetchWispHome: h.fetchWispHome,
  fetchWispPartnerEnabled: h.fetchWispPartnerEnabled,
}));
vi.mock('../ai/WispGrantStepUpModal', () => ({
  default: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return props.open ? <div data-testid="wisp-grant-modal-mock" /> : null;
  },
}));
// The real rail owns `id="needs-you"` (through WispNeedsYou); the stub carries it the same way.
vi.mock('./WispRail', () => ({
  default: (props: Record<string, unknown>) => {
    h.railProps = props;
    return (
      <div data-testid="wisp-rail">
        <section id="needs-you" data-testid="wisp-rail-needs-you" />
      </div>
    );
  },
}));
// The real thread column owns `id="thread"` and renders `leading` as the first item of the thread.
vi.mock('./WispHomeThread', () => ({
  default: (props: Record<string, unknown>) => {
    h.threadProps = props;
    return (
      <section id="thread" data-testid="wisp-home-thread">
        {props.leading as ReactNode}
      </section>
    );
  },
}));

import WispHomeContent from './WispHomeContent';

const payload = (over: Partial<WispHomePayload> = {}): WispHomePayload => ({
  thread: { id: 'th-1', grantId: 'g-1', summary: '', summaryUpdatedAt: null, lastSessionId: 's-9', focusOrgId: null, createdAt: '', updatedAt: '' },
  focusOrgName: null,
  grant: { id: 'g-1', status: 'active', orgId: null, expiresAt: '2026-12-01T00:00:00Z', currentRevisionId: null, budgetCentsPerDay: 200, floorTickMinutes: 30, spentTodayCents: 0, budgetResetsAt: '2026-10-25T00:00:00Z', pausedReason: null },
  wideningAvailable: false,
  brief: { sentAt: new Date().toISOString(), sections: [{ heading: 'Overnight', lines: ['Two backups failed at Acme'] }] },
  needsYou: [],
  activity: { items: [], nextCursor: null },
  current: null,
  links: [{ id: 'l-1', ref: { kind: 'ticket', id: 't-1', orgId: 'o-1' }, label: '#1 Jam', status: 'open', href: '/tickets/t-1', addedBy: 'user', createdAt: '' }],
  partner: { enabled: true },
  ...over,
});
const wisp = { grantId: 'g-1', threadId: 'th-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active', expiresAt: '2026-12-01T00:00:00Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false };

const concern = (id: string, status: ConcernStatus): Concern => ({
  id,
  partnerId: 'p-1',
  orgId: 'o-1',
  subject: { kind: 'device', id: 'd-1' },
  summary: `Concern ${id}`,
  severity: 'medium',
  status,
  evidence: {},
  outcome: null,
  signature: null,
  childConcernIds: [],
  approvalIntentId: null,
  createdAt: '',
  updatedAt: '',
  resolvedAt: null,
});

const linkIds = (props: null | Record<string, unknown>) => (props?.links as Array<{ id: string }>).map((l) => l.id);

describe('WispHomeContent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps queued *Once answers: a failed case must not leak its reads into the next.
    h.fetchWispHome.mockReset();
    h.wide = true;
    h.organizations = [];
    h.railProps = null;
    h.threadProps = null;
    h.store = { wisp: null, updateWisp: vi.fn(), exitWispMode: vi.fn() };
    h.entitlement = { state: 'enabled', failed: false, reload: vi.fn() };
    h.fetchWispPartnerEnabled.mockResolvedValue(true);
  });

  it('no grant → the start card; Start opens the step-up modal and a grant reloads the home', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'noGrant' }).mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    fireEvent.click(await screen.findByTestId('wisp-home-start-button'));
    expect(screen.getByTestId('wisp-grant-modal-mock')).toBeInTheDocument();
    await (h.modalProps?.onGranted as (w: unknown) => Promise<void>)(wisp);
    expect(await screen.findByTestId('wisp-home-thread')).toBeInTheDocument();
  });

  it('not entitled → FeatureLock around the start card, and no home read', async () => {
    h.entitlement = { state: 'locked', failed: false, reload: vi.fn() };
    render(<WispHomeContent />);
    expect(screen.getByTestId('wisp-home-locked')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-home-locked-cta')).toHaveAttribute('href', '/settings/plan');
    expect(h.fetchWispHome).not.toHaveBeenCalled();
  });

  it('the hub answers entitlement_required → the same FeatureLock', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'locked' });
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-home-locked')).toBeInTheDocument();
  });

  it('partner switch off and no grant → the explanation, no start button', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'noGrant' });
    h.fetchWispPartnerEnabled.mockResolvedValue(false);
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-home-disabled')).toBeInTheDocument();
    expect(screen.queryByTestId('wisp-home-start-button')).toBeNull();
  });

  it('a failed switch read still offers the start card (the grant route refuses PARTNER_DISABLED itself)', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'noGrant' });
    h.fetchWispPartnerEnabled.mockRejectedValue(new Error('500'));
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-home-start-button')).toBeInTheDocument();
  });

  it('start and locked states still render the framed heading', async () => {
    const framed = () => {
      expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
      expect(screen.getByTestId('wisp-home-chats')).toHaveAttribute('href', '/ai/chat');
      expect(screen.getByTestId('wisp-home-memory')).toHaveAttribute('href', '/settings/wisp-memory');
      expect(screen.queryByTestId('wisp-rail')).toBeNull();
    };
    h.fetchWispHome.mockResolvedValue({ kind: 'noGrant' });
    const start = render(<WispHomeContent />);
    await screen.findByTestId('wisp-home-start');
    framed();
    start.unmount();

    h.entitlement = { state: 'locked', failed: false, reload: vi.fn() };
    render(<WispHomeContent />);
    expect(screen.getByTestId('wisp-home-locked')).toBeInTheDocument();
    framed();
  });

  it('ready state renders the column, the rail and no h1', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    const thread = await screen.findByTestId('wisp-home-thread');
    const home = screen.getByTestId('wisp-home');
    expect(home).toContainElement(thread);
    expect(screen.getByTestId('wisp-rail-aside')).toContainElement(screen.getByTestId('wisp-rail'));
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // The framed nav is gone: the chats and memory links live in the rail footer now.
    expect(screen.queryByTestId('wisp-home-chats')).toBeNull();
    expect(screen.queryByTestId('wisp-home-disabled')).toBeNull();
    expect(h.threadProps).toMatchObject({
      lastSessionId: 's-9',
      scopeLabel: 'All organizations',
      links: [expect.objectContaining({ id: 'l-1' })],
      wisp: expect.objectContaining({ threadId: 'th-1' }),
    });
    expect(h.railProps).toMatchObject({
      wisp: expect.objectContaining({ threadId: 'th-1' }),
      orgName: null,
      current: null,
      needsYou: [],
      links: [expect.objectContaining({ id: 'l-1' })],
      activityKey: 0,
    });
  });

  it('an org-scoped grant labels the thread and the rail with the org name', async () => {
    h.organizations = [{ id: 'o-1', name: 'Acme' }];
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload(), wisp: { ...wisp, scopeOrgId: 'o-1' } });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-home-thread');
    expect(h.threadProps).toMatchObject({ scopeLabel: 'Acme' });
    expect(h.railProps).toMatchObject({ orgName: 'Acme' });
  });

  it('the brief reaches the thread as a timeline post (W02b), never as a leading post', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-home-thread');
    expect(screen.queryByTestId('wisp-brief-card')).toBeNull();
    expect(h.threadProps?.leading).toBeUndefined();
    expect(h.threadProps?.refreshKey).toBe(0);
  });

  it('a newer brief, a new concern or a check starting re-reads the thread timeline, once per change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = payload();
      h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: first, wisp });
      render(<WispHomeContent />);
      await screen.findByTestId('wisp-home-thread');
      const poll = async (next: WispHomePayload) => {
        h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: next, wisp });
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      };

      await poll(first);
      expect(h.threadProps?.refreshKey).toBe(0);

      const newerBrief = payload({ brief: { sentAt: new Date(Date.now() + 60_000).toISOString(), sections: [] } });
      await poll(newerBrief);
      await waitFor(() => expect(h.threadProps?.refreshKey).toBe(1));
      await poll(newerBrief);
      expect(h.threadProps?.refreshKey).toBe(1);

      const withConcern = { ...newerBrief, needsYou: [concern('c-9', 'open')] };
      await poll(withConcern);
      await waitFor(() => expect(h.threadProps?.refreshKey).toBe(2));

      await poll({ ...withConcern, current: { orgId: 'o-1', orgName: 'Acme', startedAt: new Date().toISOString() } });
      await waitFor(() => expect(h.threadProps?.refreshKey).toBe(3));
    } finally {
      vi.useRealTimers();
    }
  });

  it("the rail gets the home payload's needs-you and links; the strip count counts live concerns only", async () => {
    h.wide = false;
    const needsYou = [concern('c-1', 'open'), concern('c-2', 'snoozed'), concern('c-3', 'resolved'), concern('c-4', 'dismissed')];
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload({ needsYou }), wisp });
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-rail-strip-needs-you')).toHaveTextContent('2 items');
    // Narrow: no aside; the rail mounts only inside the drawer.
    expect(screen.queryByTestId('wisp-rail-aside')).toBeNull();
    expect(screen.queryByTestId('wisp-rail')).toBeNull();
    fireEvent.click(screen.getByTestId('wisp-rail-details'));
    expect(within(await screen.findByTestId('wisp-rail-drawer')).getByTestId('wisp-rail')).toBeInTheDocument();
    // The full payload goes to the rail: WispNeedsYou applies the live rule itself.
    expect((h.railProps?.needsYou as Concern[]).map((c) => c.id)).toEqual(['c-1', 'c-2', 'c-3', 'c-4']);
    expect(linkIds(h.railProps)).toEqual(['l-1']);
  });

  it('the partner switch off shows the explanation above the thread; a paused grant reaches the rail and the thread', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload({ partner: { enabled: false } }), wisp: { ...wisp, status: 'paused' } });
    render(<WispHomeContent />);
    const disabled = await screen.findByTestId('wisp-home-disabled');
    expect(screen.getByTestId('wisp-home')).toContainElement(disabled);
    expect(disabled.compareDocumentPosition(screen.getByTestId('wisp-home-thread')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(h.railProps?.wisp).toMatchObject({ status: 'paused' });
    expect(h.threadProps?.wisp).toMatchObject({ status: 'paused' });
  });

  it('#10104: Resume (a grant status change) refreshes the rail panes, so a pane that failed while paused reloads', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload(), wisp: { ...wisp, status: 'paused' } });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-home-thread');
    const before = h.railProps?.activityKey;
    act(() => (h.railProps?.onWispChange as (p: unknown) => void)({ status: 'active', pausedReason: null }));
    await waitFor(() => expect(h.railProps?.activityKey).not.toBe(before));
  });

  it('a permission refusal (Partner Viewer) says there is no access, with no retry (#10145)', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'forbidden' });
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-home-forbidden')).toHaveTextContent("You don't have access to Wisp");
    expect(screen.queryByTestId('wisp-home-retry')).toBeNull();
    expect(screen.queryByTestId('wisp-home-load-error')).toBeNull();
    // #10200: no links into surfaces the viewer cannot use either (chats, Wisp memory).
    expect(screen.queryByTestId('wisp-home-chats')).toBeNull();
    expect(screen.queryByTestId('wisp-home-memory')).toBeNull();
  });

  it('a broken read is an error with retry, never a guessed state', async () => {
    h.fetchWispHome.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({ kind: 'noGrant' });
    render(<WispHomeContent />);
    fireEvent.click(await screen.findByTestId('wisp-home-retry'));
    await waitFor(() => expect(screen.getByTestId('wisp-home-start')).toBeInTheDocument());
  });

  /** Start a background poll whose answer the test releases (the visible-tab catch-up path). */
  function deferPoll() {
    let release!: (v: unknown) => void;
    h.fetchWispHome.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    return (v: unknown) => act(async () => { release(v); });
  }

  const added = { id: 'l-2', ref: { kind: 'device', id: 'd-1', orgId: 'o-1' }, label: 'host-1', status: 'online', href: '/devices/d-1', addedBy: 'user', createdAt: '' };

  it('a link added in the rail while a poll is in flight survives that poll', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-rail');
    const release = deferPoll();
    act(() => (h.railProps?.onLinksChange as (l: unknown[]) => void)([...(h.railProps?.links as unknown[]), added]));
    await release({ kind: 'ready', payload: payload(), wisp });
    expect(linkIds(h.railProps)).toEqual(['l-1', 'l-2']);
    expect(linkIds(h.threadProps)).toEqual(['l-1', 'l-2']);
  });

  it('a link added from the composer reaches the rail', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-home-thread');
    act(() => (h.threadProps?.onLinksChange as (l: unknown[]) => void)([...(h.threadProps?.links as unknown[]), added]));
    expect(linkIds(h.railProps)).toEqual(['l-1', 'l-2']);
  });

  it('a pause the server just confirmed survives a poll that started before it', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-rail');
    const release = deferPoll();
    act(() => (h.railProps?.onWispChange as (p: unknown) => void)({ status: 'paused', pausedReason: 'user_paused' }));
    await release({ kind: 'ready', payload: payload(), wisp });
    expect(h.railProps?.wisp).toMatchObject({ status: 'paused' });
    expect(h.threadProps?.wisp).toMatchObject({ status: 'paused' });
    // The store does not own this thread: its Wisp state is not touched.
    expect(h.store.updateWisp).not.toHaveBeenCalled();
  });

  it('two failed background polls mark the page stale but keep it; the next good poll clears it', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-rail');
    h.fetchWispHome.mockRejectedValueOnce(new Error('500')).mockRejectedValueOnce(new Error('500'));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.queryByTestId('wisp-home-stale')).toBeNull();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByTestId('wisp-home-stale')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-rail')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-home-thread')).toBeInTheDocument();
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.queryByTestId('wisp-home-stale')).toBeNull();
  });

  it('revoking a grant the docked chat is running leaves Wisp mode there before reloading', async () => {
    h.store.wisp = { threadId: 'th-1' };
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp }).mockResolvedValueOnce({ kind: 'noGrant' });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-rail');
    act(() => (h.railProps?.onWispChange as (p: unknown) => void)({ spentTodayCents: 40 }));
    expect(h.store.updateWisp).toHaveBeenCalledWith({ spentTodayCents: 40 });
    await act(async () => { await (h.railProps?.onRevoked as () => Promise<void>)(); });
    expect(h.store.exitWispMode).toHaveBeenCalled();
    expect(await screen.findByTestId('wisp-home-start')).toBeInTheDocument();
  });

  describe('hash deep links', () => {
    const scrolled: Element[] = [];
    beforeEach(() => {
      scrolled.length = 0;
      Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    });
    afterEach(() => {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      window.history.replaceState(null, '', window.location.pathname);
    });

    it('#brief lands on the thread column (briefs are posts in it); #needs-you lands on the rail section', async () => {
      window.history.replaceState(null, '', '#brief');
      h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload(), wisp });
      render(<WispHomeContent />);
      const thread = await screen.findByTestId('wisp-home-thread');
      await waitFor(() => expect(scrolled).toContain(thread));

      window.history.replaceState(null, '', '#needs-you');
      act(() => { window.dispatchEvent(new HashChangeEvent('hashchange')); });
      expect(scrolled).toContain(screen.getByTestId('wisp-rail-needs-you'));
    });
  });
});
