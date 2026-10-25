/**
 * W08 (#9921) Task 9: the Wisp home's four states from a mocked GET /wisp/home —
 * no grant (start card), not entitled (FeatureLock), partner switch off
 * (explanation, no start button), and populated (every section).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispHomePayload } from '@breeze/shared';

const h = vi.hoisted(() => ({
  entitlement: { state: 'enabled', failed: false, reload: vi.fn() } as Record<string, unknown>,
  fetchWispHome: vi.fn(),
  fetchWispPartnerEnabled: vi.fn(),
  modalProps: null as null | Record<string, unknown>,
  threadProps: null as null | Record<string, unknown>,
  linksProps: null as null | Record<string, unknown>,
  headerProps: null as null | Record<string, unknown>,
  store: { wisp: null as null | Record<string, unknown>, updateWisp: vi.fn(), exitWispMode: vi.fn() },
}));
vi.mock('@/hooks/useEntitlement', () => ({ useEntitlement: () => h.entitlement }));
vi.mock('@/stores/orgStore', () => ({ useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: [], currentOrgId: null }) }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: unknown) => unknown) => sel(h.store),
}));
vi.mock('./wispHome', async (orig) => ({
  ...(await orig<typeof import('./wispHome')>()),
  fetchWispHome: h.fetchWispHome,
  fetchWispPartnerEnabled: h.fetchWispPartnerEnabled,
}));
vi.mock('../ai/WispThreadHeader', () => ({
  default: (props: Record<string, unknown>) => {
    h.headerProps = props;
    return <div data-testid="wisp-thread-header-mock" />;
  },
}));
vi.mock('../ai/WispGrantStepUpModal', () => ({
  default: (props: Record<string, unknown>) => {
    h.modalProps = props;
    return props.open ? <div data-testid="wisp-grant-modal-mock" /> : null;
  },
}));
vi.mock('./WispActivityPanel', () => ({ default: () => <div data-testid="wisp-activity-mock" /> }));
vi.mock('./WispNeedsYou', () => ({ default: () => <div data-testid="wisp-needs-you-mock" /> }));
vi.mock('./WispHomeThread', () => ({
  default: (props: Record<string, unknown>) => {
    h.threadProps = props;
    return <div data-testid="wisp-home-thread-mock" />;
  },
}));
vi.mock('./WispLinksPanel', () => ({
  default: (props: Record<string, unknown>) => {
    h.linksProps = props;
    return <div data-testid="wisp-links-mock" />;
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

describe('WispHomeContent (W08 Task 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(await screen.findByTestId('wisp-home-thread-mock')).toBeInTheDocument();
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

  it('populated → header, brief, needs you, activity, thread (resuming the last session) and links; chats + memory links', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-thread-header-mock')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-brief-card')).toHaveTextContent('Two backups failed at Acme');
    expect(screen.getByTestId('wisp-needs-you-mock')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-activity-mock')).toBeInTheDocument();
    expect(h.threadProps).toMatchObject({ lastSessionId: 's-9', wisp: expect.objectContaining({ threadId: 'th-1' }) });
    expect(h.linksProps).toMatchObject({ threadId: 'th-1', canAdd: true, links: [expect.objectContaining({ id: 'l-1' })] });
    expect(screen.getByTestId('wisp-home-chats')).toHaveAttribute('href', '/wisp/chat');
    expect(screen.getByTestId('wisp-home-memory')).toHaveAttribute('href', '/settings/wisp-memory');
    expect(screen.queryByTestId('wisp-home-disabled')).toBeNull();
  });

  it('a paused grant cannot add links; the partner switch off shows the explanation above the home', async () => {
    h.fetchWispHome.mockResolvedValue({ kind: 'ready', payload: payload({ partner: { enabled: false } }), wisp: { ...wisp, status: 'paused' } });
    render(<WispHomeContent />);
    expect(await screen.findByTestId('wisp-home-disabled')).toBeInTheDocument();
    expect(h.linksProps).toMatchObject({ canAdd: false });
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

  it('a link added while a poll is in flight survives that poll', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-links-mock');
    const release = deferPoll();
    const added = { id: 'l-2', ref: { kind: 'device', id: 'd-1', orgId: 'o-1' }, label: 'host-1', status: 'online', href: '/devices/d-1', addedBy: 'user', createdAt: '' };
    act(() => (h.linksProps?.onLinksChange as (l: unknown[]) => void)([...(h.linksProps?.links as unknown[]), added]));
    await release({ kind: 'ready', payload: payload(), wisp });
    expect((h.linksProps?.links as Array<{ id: string }>).map((l) => l.id)).toEqual(['l-1', 'l-2']);
  });

  it('a pause the server just confirmed survives a poll that started before it', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-thread-header-mock');
    const release = deferPoll();
    act(() => (h.headerProps?.onWispChange as (p: unknown) => void)({ status: 'paused', pausedReason: 'user_paused' }));
    await release({ kind: 'ready', payload: payload(), wisp });
    expect(h.headerProps?.wisp).toMatchObject({ status: 'paused' });
    // The store does not own this thread: its Wisp state is not touched.
    expect(h.store.updateWisp).not.toHaveBeenCalled();
  });

  it('two failed background polls mark the page stale but keep it; the next good poll clears it', async () => {
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-thread-header-mock');
    h.fetchWispHome.mockRejectedValueOnce(new Error('500')).mockRejectedValueOnce(new Error('500'));
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.queryByTestId('wisp-home-stale')).toBeNull();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.getByTestId('wisp-home-stale')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-thread-header-mock')).toBeInTheDocument();
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(screen.queryByTestId('wisp-home-stale')).toBeNull();
  });

  it('revoking a grant the docked chat is running leaves Wisp mode there before reloading', async () => {
    h.store.wisp = { threadId: 'th-1' };
    h.fetchWispHome.mockResolvedValueOnce({ kind: 'ready', payload: payload(), wisp }).mockResolvedValueOnce({ kind: 'noGrant' });
    render(<WispHomeContent />);
    await screen.findByTestId('wisp-thread-header-mock');
    act(() => (h.headerProps?.onWispChange as (p: unknown) => void)({ spentTodayCents: 40 }));
    expect(h.store.updateWisp).toHaveBeenCalledWith({ spentTodayCents: 40 });
    await act(async () => { await (h.headerProps?.onRevoked as () => Promise<void>)(); });
    expect(h.store.exitWispMode).toHaveBeenCalled();
    expect(await screen.findByTestId('wisp-home-start')).toBeInTheDocument();
  });
});
