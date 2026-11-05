import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionError } from '@/lib/runAction';

const h = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  addWispLink: vi.fn(),
  showToast: vi.fn(),
  user: null as Record<string, unknown> | null,
}));
vi.mock('@/stores/auth', () => ({
  fetchWithAuth: h.fetchWithAuth,
  useAuthStore: (sel: (s: { user: unknown }) => unknown) => sel({ user: h.user }),
}));
vi.mock('@/lib/wispLinksApi', () => ({ addWispLink: h.addWispLink }));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));

import WispEntityPicker from './WispEntityPicker';

const res = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const deferred = () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
};

const tickets = {
  data: [
    { id: 't1', orgId: 'org-a', internalNumber: 7, subject: 'Printer jam', status: 'open' },
    { id: 't2', orgId: 'org-a', internalNumber: 8, subject: 'VPN down', status: 'new' },
  ],
};
const quotes = {
  data: [
    { id: 'q1', orgId: 'org-a', quoteNumber: 'Q-0001', title: 'Laptops', status: 'draft' },
    { id: 'q2', orgId: 'org-a', quoteNumber: 'Q-0002', title: 'Firewall', status: 'sent' },
  ],
};

const link = { id: 'l1', ref: { kind: 'ticket', id: 't1', orgId: 'org-a' }, label: '#7 Printer jam', status: 'open', href: '/tickets/t1', source: 'user_pin', lastTouchedAt: '2026-10-24T08:00:00Z', createdAt: '2026-10-24T00:00:00.000Z' };

function renderPicker(props: Partial<Parameters<typeof WispEntityPicker>[0]> = {}) {
  const onClose = vi.fn();
  const onLinked = vi.fn();
  render(
    <WispEntityPicker open threadId="th-1" linkedKeys={new Set<string>()} onClose={onClose} onLinked={onLinked} {...props} />,
  );
  return { onClose, onLinked };
}

// A full-access partner admin: the `*:*` grant and orgAccess 'all'.
const ALL_ORG_ADMIN = { id: 'u-1', permissions: [{ resource: '*', action: '*' }], canManagePartnerWide: true };
const users = { data: [{ id: 'u-2', name: 'Ada Lovelace', email: 'ada@example.com', status: 'active' }] };

beforeEach(() => {
  vi.clearAllMocks();
  h.user = ALL_ORG_ADMIN;
  h.fetchWithAuth.mockImplementation(async (url: string) => (url.startsWith('/quotes') ? res(200, quotes) : res(200, tickets)));
});

describe('WispEntityPicker (W08 T9)', () => {
  it('renders nothing when closed', () => {
    renderPicker({ open: false });
    expect(screen.queryByTestId('wisp-entity-picker')).toBeNull();
    expect(h.fetchWithAuth).not.toHaveBeenCalled();
  });

  it('opens as a labelled dialog on Tickets and lists them, letting the org switcher scope the read', async () => {
    renderPicker();
    const dialog = screen.getByRole('dialog');
    const titleId = dialog.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId!)?.textContent).toBe('Link an item to Wisp');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(screen.getByRole('tablist', { name: 'Item type' })).toBeTruthy();
    expect(screen.getByTestId('wisp-picker-kind-ticket').getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByTestId('wisp-picker-row-ticket-t1')).toBeTruthy();
    expect(screen.getByTestId('wisp-picker-row-ticket-t1').textContent).toContain('#7 Printer jam');
    expect(h.fetchWithAuth).toHaveBeenCalledWith('/tickets?limit=25');
    expect(h.fetchWithAuth.mock.calls[0]).toHaveLength(1);
  });

  it('re-fetches tickets with the debounced search', async () => {
    renderPicker();
    await screen.findByTestId('wisp-picker-row-ticket-t1');
    fireEvent.change(screen.getByTestId('wisp-picker-search'), { target: { value: 'printer' } });
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledWith('/tickets?limit=25&search=printer'));
    expect(h.fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('links the chosen ticket with its org and reports the link', async () => {
    h.addWispLink.mockResolvedValue(link);
    const { onLinked } = renderPicker();
    fireEvent.click(await screen.findByTestId('wisp-picker-row-ticket-t1'));
    await waitFor(() => expect(onLinked).toHaveBeenCalledWith(link));
    expect(h.addWispLink).toHaveBeenCalledWith('th-1', { kind: 'ticket', id: 't1', orgId: 'org-a' });
  });

  it('disables every row while a link is in flight', async () => {
    let finish!: (l: unknown) => void;
    h.addWispLink.mockReturnValue(new Promise((r) => { finish = r; }));
    const { onLinked } = renderPicker();
    fireEvent.click(await screen.findByTestId('wisp-picker-row-ticket-t1'));
    await waitFor(() => expect((screen.getByTestId('wisp-picker-row-ticket-t2') as HTMLButtonElement).disabled).toBe(true));
    finish(link);
    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId('wisp-picker-row-ticket-t2') as HTMLButtonElement).disabled).toBe(false));
  });

  it('disables a row that is already linked', async () => {
    renderPicker({ linkedKeys: new Set(['ticket:t2']) });
    const row = (await screen.findByTestId('wisp-picker-row-ticket-t2')) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain('Already linked');
    expect((screen.getByTestId('wisp-picker-row-ticket-t1') as HTMLButtonElement).disabled).toBe(false);
  });

  it('fetches Quotes once and filters them client-side', async () => {
    renderPicker();
    await screen.findByTestId('wisp-picker-row-ticket-t1');
    fireEvent.click(screen.getByTestId('wisp-picker-kind-quote'));
    expect(await screen.findByTestId('wisp-picker-row-quote-q1')).toBeTruthy();
    expect(screen.getByTestId('wisp-picker-kind-quote').getAttribute('aria-selected')).toBe('true');
    fireEvent.change(screen.getByTestId('wisp-picker-search'), { target: { value: 'firew' } });
    await waitFor(() => expect(screen.queryByTestId('wisp-picker-row-quote-q1')).toBeNull());
    expect(screen.getByTestId('wisp-picker-row-quote-q2')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 350)); // past the debounce: still no re-fetch
    const quoteCalls = h.fetchWithAuth.mock.calls.filter(([u]) => String(u).startsWith('/quotes'));
    expect(quoteCalls).toEqual([['/quotes?limit=50']]);
  });

  it('shows the empty state when nothing matches', async () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('wisp-picker-kind-quote'));
    await screen.findByTestId('wisp-picker-row-quote-q1');
    fireEvent.change(screen.getByTestId('wisp-picker-search'), { target: { value: 'zzz' } });
    expect((await screen.findByTestId('wisp-picker-empty')).textContent).toBe('No matches.');
  });

  it('shows the error state, not an empty list, on a 500', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.fetchWithAuth.mockResolvedValue(res(500, { error: 'boom' }));
    renderPicker();
    expect((await screen.findByTestId('wisp-picker-error')).textContent).toContain('Could not load this list.');
    expect(screen.queryByTestId('wisp-picker-empty')).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('[WispEntityPicker]'), expect.anything());
    err.mockRestore();
  });

  it('treats a body without a data array as an error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.fetchWithAuth.mockResolvedValue(res(200, { items: [] }));
    renderPicker();
    expect(await screen.findByTestId('wisp-picker-error')).toBeTruthy();
    expect(screen.queryByTestId('wisp-picker-empty')).toBeNull();
    err.mockRestore();
  });

  it('shows no toast and does not report a link on a 401 ActionError', async () => {
    h.addWispLink.mockRejectedValue(new ActionError('Unauthorized', 401));
    const { onLinked } = renderPicker();
    fireEvent.click(await screen.findByTestId('wisp-picker-row-ticket-t1'));
    await waitFor(() => expect(h.addWispLink).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByTestId('wisp-picker-row-ticket-t1') as HTMLButtonElement).disabled).toBe(false));
    expect(h.showToast).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('does not re-toast an ActionError runAction already reported', async () => {
    h.addWispLink.mockRejectedValue(new ActionError('Not found', 404, 'not_found'));
    const { onLinked } = renderPicker();
    fireEvent.click(await screen.findByTestId('wisp-picker-row-ticket-t1'));
    await waitFor(() => expect((screen.getByTestId('wisp-picker-row-ticket-t1') as HTMLButtonElement).disabled).toBe(false));
    expect(h.showToast).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('toasts a failure that did not come through runAction', async () => {
    h.addWispLink.mockRejectedValue(new Error('wisp link add: response has no link'));
    const { onLinked } = renderPicker();
    fireEvent.click(await screen.findByTestId('wisp-picker-row-ticket-t1'));
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Could not link that item.' }));
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('closes on Escape and on the close button', async () => {
    const { onClose } = renderPicker();
    fireEvent.keyDown(screen.getByTestId('wisp-picker-search'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale response from the previous kind', async () => {
    const slowTickets = deferred();
    h.fetchWithAuth.mockImplementation((url: string) =>
      url.startsWith('/quotes') ? Promise.resolve(res(200, quotes)) : slowTickets.promise);
    renderPicker();
    expect(screen.getByTestId('wisp-picker-loading')).toBeTruthy();
    fireEvent.click(screen.getByTestId('wisp-picker-kind-quote'));
    await screen.findByTestId('wisp-picker-row-quote-q1');
    slowTickets.resolve(res(200, tickets));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('wisp-picker-row-ticket-t1')).toBeNull();
    expect(screen.getByTestId('wisp-picker-row-quote-q1')).toBeTruthy();
  });

  it('ignores an out-of-order search response', async () => {
    const slowFirst = deferred();
    h.fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/tickets?limit=25&search=pri') return slowFirst.promise;
      if (url === '/tickets?limit=25&search=printer') return Promise.resolve(res(200, { data: [tickets.data[0]] }));
      return Promise.resolve(res(200, tickets));
    });
    renderPicker();
    await screen.findByTestId('wisp-picker-row-ticket-t2');
    fireEvent.change(screen.getByTestId('wisp-picker-search'), { target: { value: 'pri' } });
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledWith('/tickets?limit=25&search=pri'));
    fireEvent.change(screen.getByTestId('wisp-picker-search'), { target: { value: 'printer' } });
    await waitFor(() => expect(h.fetchWithAuth).toHaveBeenCalledWith('/tickets?limit=25&search=printer'));
    await screen.findByTestId('wisp-picker-row-ticket-t1');
    expect(screen.queryByTestId('wisp-picker-row-ticket-t2')).toBeNull();
    slowFirst.resolve(res(200, tickets));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('wisp-picker-row-ticket-t2')).toBeNull();
    expect(screen.getByTestId('wisp-picker-row-ticket-t1')).toBeTruthy();
  });

  // #10113: user links are partner-level, and the partner user list (`GET /users`)
  // 403s a partner user without orgAccess 'all' — the same condition under which the
  // grant ceiling refuses a partner-level link. The tab is offered only when both hold.
  describe('Users tab (#10113)', () => {
    it('is offered to an all-org partner user with users:read and lists partner users', async () => {
      h.user = { id: 'u-1', permissions: [{ resource: 'users', action: 'read' }], canManagePartnerWide: true };
      h.fetchWithAuth.mockImplementation(async (url: string) => (url === '/users' ? res(200, users) : res(200, tickets)));
      renderPicker();
      fireEvent.click(screen.getByTestId('wisp-picker-kind-user'));
      expect((await screen.findByTestId('wisp-picker-row-user-u-2')).textContent).toContain('Ada Lovelace <ada@example.com>');
      expect(h.fetchWithAuth).toHaveBeenCalledWith('/users');
    });

    it('is not offered to an org-restricted partner user, and /users is never requested', async () => {
      h.user = { id: 'u-1', permissions: [{ resource: '*', action: '*' }], canManagePartnerWide: false };
      renderPicker();
      await screen.findByTestId('wisp-picker-row-ticket-t1');
      expect(screen.queryByTestId('wisp-picker-kind-user')).toBeNull();
      expect(screen.getByTestId('wisp-picker-kind-organization')).toBeTruthy();
      expect(h.fetchWithAuth.mock.calls.some(([u]) => String(u).startsWith('/users'))).toBe(false);
    });

    it('is not offered without users:read, even with full org access', async () => {
      h.user = { id: 'u-1', permissions: [{ resource: 'tickets', action: 'read' }], canManagePartnerWide: true };
      renderPicker();
      await screen.findByTestId('wisp-picker-row-ticket-t1');
      expect(screen.queryByTestId('wisp-picker-kind-user')).toBeNull();
    });

    it('is not offered while org access is unknown (a session from before the field)', async () => {
      h.user = { id: 'u-1', permissions: [{ resource: '*', action: '*' }] };
      renderPicker();
      await screen.findByTestId('wisp-picker-row-ticket-t1');
      expect(screen.queryByTestId('wisp-picker-kind-user')).toBeNull();
    });

    it('is not offered when no user is loaded', async () => {
      h.user = null;
      renderPicker();
      await screen.findByTestId('wisp-picker-row-ticket-t1');
      expect(screen.queryByTestId('wisp-picker-kind-user')).toBeNull();
    });

    // Uses ALL_ORG_ADMIN's `*:*` grant, so it also pins the wildcard positive case.
    it('falls back to Tickets when access drops while the Users tab is open', async () => {
      h.fetchWithAuth.mockImplementation(async (url: string) => (url === '/users' ? res(200, users) : res(200, tickets)));
      const view = render(
        <WispEntityPicker open threadId="th-1" linkedKeys={new Set<string>()} onClose={vi.fn()} onLinked={vi.fn()} />,
      );
      fireEvent.click(screen.getByTestId('wisp-picker-kind-user'));
      await screen.findByTestId('wisp-picker-row-user-u-2');
      h.user = { ...ALL_ORG_ADMIN, canManagePartnerWide: false };
      h.fetchWithAuth.mockClear();
      view.rerender(
        <WispEntityPicker open threadId="th-1" linkedKeys={new Set<string>()} onClose={vi.fn()} onLinked={vi.fn()} />,
      );
      expect(await screen.findByTestId('wisp-picker-row-ticket-t1')).toBeTruthy();
      expect(screen.getByTestId('wisp-picker-kind-ticket').getAttribute('aria-selected')).toBe('true');
      expect(screen.queryByTestId('wisp-picker-row-user-u-2')).toBeNull();
      expect(h.fetchWithAuth.mock.calls.some(([u]) => String(u).startsWith('/users'))).toBe(false);

      // Access coming back shows the tab again but does not jump back to it.
      h.user = ALL_ORG_ADMIN;
      view.rerender(
        <WispEntityPicker open threadId="th-1" linkedKeys={new Set<string>()} onClose={vi.fn()} onLinked={vi.fn()} />,
      );
      expect(screen.getByTestId('wisp-picker-kind-user').getAttribute('aria-selected')).toBe('false');
      expect(screen.getByTestId('wisp-picker-kind-ticket').getAttribute('aria-selected')).toBe('true');
      await new Promise((r) => setTimeout(r, 20));
      expect(h.fetchWithAuth.mock.calls.some(([u]) => String(u).startsWith('/users'))).toBe(false);
    });
  });
});
