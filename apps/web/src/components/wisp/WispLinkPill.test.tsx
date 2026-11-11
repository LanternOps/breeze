import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispThreadLink } from '@breeze/shared';
const h = vi.hoisted(() => ({ listWispNeighbours: vi.fn(), showToast: vi.fn() }));
vi.mock('@/lib/wispLinksApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/wispLinksApi')>(),
  listWispNeighbours: h.listWispNeighbours,
}));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));
beforeEach(() => vi.clearAllMocks());

import WispLinkPill from './WispLinkPill';

const link = (source: WispThreadLink['source'], lastTouchedAt = new Date().toISOString()): WispThreadLink => ({
  id: source === 'concern' ? null : 'l1', ref: { kind: 'ticket', id: 't1', orgId: 'o1' },
  label: 'Printer', href: '/tickets/t1', status: 'open', source, lastTouchedAt, createdAt: lastTouchedAt,
});

describe('WispLinkPill', () => {
  it.each(['user_pin', 'wisp_pin', 'auto', 'concern'] as const)('%s has the right actions', (source) => {
    const remove = vi.fn(), pin = vi.fn(), dismiss = vi.fn();
    const key = source === 'concern' ? 'ticket:t1' : 'l1';
    render(<WispLinkPill link={link(source)} threadId="th1" onRemove={remove} onPin={pin} onDismiss={dismiss} />);
    expect(screen.queryByTestId(`wisp-link-remove-${key}`) !== null).toBe(source.endsWith('_pin'));
    expect(screen.queryByTestId(`wisp-link-pin-${key}`) !== null).toBe(source === 'auto');
    expect(screen.queryByTestId(`wisp-link-dismiss-${key}`) !== null).toBe(source === 'auto');
    expect(screen.getByTestId(`wisp-link-chip-${key}`)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/tickets/t1');
    if (source === 'auto') { fireEvent.click(screen.getByTestId('wisp-link-pin-l1')); expect(pin).toHaveBeenCalled(); }
  });
  it('auto pills older than 24 h render faded, from lastTouchedAt only', () => {
    const view = render(<WispLinkPill threadId="th1" link={link('auto', new Date(Date.now() - 86400001).toISOString())} />);
    expect(screen.getByTestId('wisp-link-chip-l1')).toHaveAttribute('data-age', 'old');
    expect(screen.getByTestId('wisp-link-chip-l1')).toHaveClass('opacity-60');
    view.rerender(<WispLinkPill threadId="th1" link={{ ...link('auto'), createdAt: '2000-01-01T00:00:00Z' }} />);
    expect(screen.getByTestId('wisp-link-chip-l1')).not.toHaveClass('opacity-60');
    view.rerender(<WispLinkPill threadId="th1" link={link('user_pin', '2000-01-01T00:00:00Z')} />);
    expect(screen.getByTestId('wisp-link-chip-l1')).not.toHaveClass('opacity-60');
  });
});

it('expand loads neighbours once, including while the first read is pending', async () => {
  let finish!: (rows: WispThreadLink[]) => void;
  h.listWispNeighbours.mockReturnValue(new Promise<WispThreadLink[]>((resolve) => { finish = resolve; }));
  render(<WispLinkPill threadId="th1" link={link('user_pin')} />);
  expect(h.listWispNeighbours).not.toHaveBeenCalled();
  const expand = screen.getByTestId('wisp-link-expand-l1');
  fireEvent.click(expand);
  expect(expand).toHaveAttribute('aria-expanded', 'true');
  expect(h.listWispNeighbours).toHaveBeenCalledWith('th1', { kind: 'ticket', id: 't1', orgId: 'o1' });
  fireEvent.click(expand);
  fireEvent.click(expand);
  const neighbour = { ...link('auto'), id: null, ref: { kind: 'device' as const, id: 'd1', orgId: 'o1' }, label: 'Workstation', href: '/devices/d1' };
  await act(async () => finish([neighbour]));
  expect(screen.getByTestId('wisp-link-chip-device:d1')).toHaveAttribute('data-source', 'auto');
  fireEvent.click(expand);
  expect(screen.queryByText('Workstation')).not.toBeInTheDocument();
  fireEvent.click(expand);
  expect(screen.getByRole('link', { name: 'Workstation' })).toHaveAttribute('href', '/devices/d1');
  expect(h.listWispNeighbours).toHaveBeenCalledTimes(1);
});

it('a failed neighbours read toasts once and does not reload on expansion', async () => {
  h.listWispNeighbours.mockRejectedValue(new Error('offline'));
  render(<WispLinkPill threadId="th1" link={link('auto')} />);
  fireEvent.click(screen.getByTestId('wisp-link-expand-l1'));
  await waitFor(() => expect(h.showToast).toHaveBeenCalledWith({ type: 'error', message: 'Could not load this list.' }));
  fireEvent.click(screen.getByTestId('wisp-link-expand-l1'));
  fireEvent.click(screen.getByTestId('wisp-link-expand-l1'));
  expect(h.listWispNeighbours).toHaveBeenCalledTimes(1);
  expect(h.showToast).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Could not load this list.')).toBeInTheDocument();
});

it('does not reuse neighbours when the thread changes', async () => {
  h.listWispNeighbours.mockResolvedValue([]);
  const view = render(<WispLinkPill threadId="th1" link={link('auto')} />);
  fireEvent.click(screen.getByTestId('wisp-link-expand-l1'));
  await waitFor(() => expect(screen.getByText('No matches.')).toBeInTheDocument());
  view.rerender(<WispLinkPill threadId="th2" link={link('auto')} />);
  expect(screen.getByTestId('wisp-link-expand-l1')).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByTestId('wisp-link-expand-l1'));
  await waitFor(() => expect(h.listWispNeighbours).toHaveBeenLastCalledWith('th2', expect.objectContaining({ id: 't1' })));
});
