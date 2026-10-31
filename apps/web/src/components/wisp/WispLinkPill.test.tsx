import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WispThreadLink } from '@breeze/shared';
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
