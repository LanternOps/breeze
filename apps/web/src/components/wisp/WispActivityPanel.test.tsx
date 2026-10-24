import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./wispActivity', async (orig) => ({ ...(await orig<typeof import('./wispActivity')>()), fetchWispActivity: h.fetch }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (sel: (s: unknown) => unknown) => sel({ organizations: [{ id: 'o1', name: 'Acme Org' }] }),
}));

import WispActivityPanel from './WispActivityPanel';

const mk = (title: string, extra: Record<string, unknown> = {}) => ({
  at: new Date(Date.now() - 3600_000).toISOString(), kind: 'concern', orgId: null, title, detail: null, href: null, costCents: null, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.fetch.mockResolvedValue({ items: [], nextCursor: null });
});

describe('WispActivityPanel', () => {
  it('renders rows in server order with org name', async () => {
    h.fetch.mockResolvedValue({ items: [mk('first', { orgId: 'o1', kind: 'nudge' }), mk('second')], nextCursor: null });
    render(<WispActivityPanel threadId="t1" />);
    const rows = await screen.findAllByTestId('wisp-activity-row');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['nudge', 'concern']);
    expect(rows[0]!.textContent).toContain('first');
    expect(rows[0]!.textContent).toContain('Acme Org');
    expect(rows[1]!.textContent).not.toContain('Acme Org');
    expect(h.fetch).toHaveBeenCalledWith('t1', null);
  });

  it('links only safe hrefs', async () => {
    h.fetch.mockResolvedValue({ items: [mk('safe', { href: '/tickets/1' }), mk('evil', { href: 'https://evil.example' })], nextCursor: null });
    render(<WispActivityPanel threadId="t1" />);
    const rows = await screen.findAllByTestId('wisp-activity-row');
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe('/tickets/1');
    expect(rows[1]!.querySelector('a')).toBeNull();
  });

  it('load more appends with the cursor', async () => {
    h.fetch.mockResolvedValueOnce({ items: [mk('a')], nextCursor: 'c1' });
    h.fetch.mockResolvedValueOnce({ items: [mk('b')], nextCursor: null });
    render(<WispActivityPanel threadId="t1" />);
    await screen.findAllByTestId('wisp-activity-row');
    fireEvent.click(screen.getByTestId('wisp-activity-load-more'));
    await waitFor(() => expect(screen.getAllByTestId('wisp-activity-row')).toHaveLength(2));
    expect(h.fetch).toHaveBeenLastCalledWith('t1', 'c1');
    expect(screen.queryByTestId('wisp-activity-load-more')).toBeNull();
  });

  it('shows the empty state', async () => {
    render(<WispActivityPanel threadId="t1" />);
    await screen.findByTestId('wisp-activity-empty');
  });

  it('shows the error state and logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.fetch.mockRejectedValue(new Error('boom'));
    render(<WispActivityPanel threadId="t1" />);
    await screen.findByTestId('wisp-activity-load-error');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reloads the first page when refreshKey changes', async () => {
    h.fetch.mockResolvedValueOnce({ items: [mk('old')], nextCursor: null });
    const { rerender } = render(<WispActivityPanel threadId="t1" refreshKey={0} />);
    await screen.findAllByTestId('wisp-activity-row');
    h.fetch.mockResolvedValueOnce({ items: [mk('new1'), mk('new2')], nextCursor: null });
    rerender(<WispActivityPanel threadId="t1" refreshKey={1} />);
    await waitFor(() => expect(screen.getAllByTestId('wisp-activity-row')).toHaveLength(2));
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores a stale response from an older load', async () => {
    let resolveOld!: (v: unknown) => void;
    h.fetch.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    h.fetch.mockResolvedValueOnce({ items: [mk('newer')], nextCursor: null });
    const { rerender } = render(<WispActivityPanel threadId="t1" refreshKey={0} />);
    rerender(<WispActivityPanel threadId="t1" refreshKey={1} />);
    await screen.findAllByTestId('wisp-activity-row');
    await act(async () => { resolveOld({ items: [mk('stale1'), mk('stale2')], nextCursor: null }); });
    expect(screen.getAllByTestId('wisp-activity-row')).toHaveLength(1);
    expect(screen.getByTestId('wisp-activity-row').textContent).toContain('newer');
  });
});
