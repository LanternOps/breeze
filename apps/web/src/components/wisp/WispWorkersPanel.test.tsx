import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./wispActivity', async (orig) => ({ ...(await orig<typeof import('./wispActivity')>()), fetchWispActivity: h.fetch }));
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import WispWorkersPanel from './WispWorkersPanel';

const mk = (title: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id: `i-${kind}-${title}`, at: new Date(Date.now() - 3600_000).toISOString(), kind, orgId: null, title, detail: null, href: null, costCents: null, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.fetch.mockResolvedValue({ items: [], nextCursor: null, current: null });
});

describe('WispWorkersPanel', () => {
  it('lists only specialist items, five at most', async () => {
    const items = [
      ...Array.from({ length: 7 }, (_, i) => mk(`spec${i}`, 'specialist', i === 0 ? { href: '/ai-agents/runs/1', detail: 'checking disks' } : i === 1 ? { href: 'https://evil.example' } : {})),
      mk('concernA', 'concern'), mk('briefA', 'brief'),
    ];
    h.fetch.mockResolvedValue({ items, nextCursor: null, current: null });
    render(<WispWorkersPanel threadId="t1" />);
    const rows = await screen.findAllByTestId('wisp-worker-row');
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.textContent).join('|')).not.toContain('concernA');
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe('/ai-agents/runs/1');
    expect(rows[0]!.textContent).toContain('checking disks');
    expect(rows[1]!.querySelector('a')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Workers');
    expect(screen.getByText('All runs').closest('a')?.getAttribute('href')).toBe('/ai-agents/runs');
    expect(h.fetch).toHaveBeenCalledWith('t1', null, 50);
  });

  it('empty and error lines', async () => {
    const { unmount } = render(<WispWorkersPanel threadId="t1" />);
    expect(await screen.findByText('No specialists running.')).toBeTruthy();
    unmount();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.fetch.mockRejectedValue(new Error('boom'));
    render(<WispWorkersPanel threadId="t1" />);
    expect(await screen.findByTestId('wisp-workers-load-error')).toBeTruthy();
    expect(screen.queryByText('No specialists running.')).toBeNull();
    spy.mockRestore();
  });

  it('refetches when refreshKey changes and ignores the stale response', async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    h.fetch.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    h.fetch.mockResolvedValueOnce({ items: [mk('fresh', 'specialist')], nextCursor: null, current: null });
    const { rerender } = render(<WispWorkersPanel threadId="t1" refreshKey={0} />);
    rerender(<WispWorkersPanel threadId="t1" refreshKey={1} />);
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('fresh')).toBeTruthy();
    resolveFirst({ items: [mk('stale', 'specialist')], nextCursor: null, current: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('stale')).toBeNull();
    expect(screen.getByText('fresh')).toBeTruthy();
  });
});
