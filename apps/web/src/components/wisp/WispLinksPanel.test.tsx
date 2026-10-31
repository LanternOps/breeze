import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WispThreadLink } from '@breeze/shared';
import { ActionError } from '@/lib/runAction';

const h = vi.hoisted(() => ({
  removeWispLink: vi.fn(),
  pinWispLink: vi.fn(),
  showToast: vi.fn(),
  pickerProps: null as null | Record<string, unknown>,
}));
vi.mock('@/lib/wispLinksApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/wispLinksApi')>(),
  removeWispLink: h.removeWispLink,
  pinWispLink: h.pinWispLink,
}));
vi.mock('@/components/shared/Toast', () => ({ showToast: h.showToast }));
vi.mock('./WispEntityPicker', () => ({
  default: (props: Record<string, unknown>) => {
    h.pickerProps = props;
    return props.open ? <div data-testid="wisp-entity-picker-mock" /> : null;
  },
}));

import WispLinksPanel from './WispLinksPanel';

const link = (id: string, over: Partial<WispThreadLink> = {}): WispThreadLink => ({
  id,
  ref: { kind: 'ticket', id: `t-${id}`, orgId: 'org-1' },
  label: `#10${id} Printer jam`,
  status: 'open',
  href: `/tickets/t-${id}`,
  source: 'user_pin', lastTouchedAt: '2026-10-24T08:00:00Z',
  createdAt: '2026-10-24T08:00:00Z',
  ...over,
});

describe('WispLinksPanel (W08 Task 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pickerProps = null;
  });

  it('renders each link as a chip to its page, with status and a Wisp marker for model-added links', () => {
    render(<WispLinksPanel threadId="th-1" links={[link('1'), link('2', { source: 'wisp_pin', lastTouchedAt: '2026-10-24T08:00:00Z', status: null })]} onLinksChange={vi.fn()} />);
    const chips = screen.getAllByTestId(/^wisp-link-chip-/);
    expect(chips).toHaveLength(2);
    expect(screen.getByRole('link', { name: /#101 Printer jam/ })).toHaveAttribute('href', '/tickets/t-1');
    expect(chips[0]).toHaveTextContent('open');
    expect(screen.getAllByTestId('wisp-link-added-by-wisp')).toHaveLength(1);
    expect(screen.getByTestId('wisp-links-count')).toHaveTextContent('2 of 50 linked');
  });

  it('shows the empty line with no links', () => {
    render(<WispLinksPanel threadId="th-1" links={[]} onLinksChange={vi.fn()} />);
    expect(screen.getByTestId('wisp-links-empty')).toBeInTheDocument();
  });

  it('does not remove a derived concern link with no persisted id', () => {
    render(<WispLinksPanel threadId="th-1" links={[link('1', { id: null, source: 'concern' })]} onLinksChange={vi.fn()} />);
    expect(screen.getByTestId('wisp-link-chip-ticket:t-1')).toBeInTheDocument();
    expect(screen.queryByTestId(/^wisp-link-remove-/)).toBeNull();
    expect(h.removeWispLink).not.toHaveBeenCalled();
  });

  it('remove goes through the runAction-backed API and drops the chip', async () => {
    h.removeWispLink.mockResolvedValue(undefined);
    const onLinksChange = vi.fn();
    render(<WispLinksPanel threadId="th-1" links={[link('1'), link('2')]} onLinksChange={onLinksChange} />);
    fireEvent.click(screen.getByTestId('wisp-link-remove-1'));
    await waitFor(() => expect(onLinksChange).toHaveBeenCalledWith([expect.objectContaining({ id: '2' })]));
    expect(h.removeWispLink).toHaveBeenCalledWith('th-1', '1');
  });

  it('an ActionError 401 on remove is swallowed (auth redirect owns it): no toast, chip kept', async () => {
    h.removeWispLink.mockRejectedValue(new ActionError('Unauthorized', 401));
    const onLinksChange = vi.fn();
    render(<WispLinksPanel threadId="th-1" links={[link('1')]} onLinksChange={onLinksChange} />);
    fireEvent.click(screen.getByTestId('wisp-link-remove-1'));
    await waitFor(() => expect(h.removeWispLink).toHaveBeenCalled());
    await Promise.resolve();
    expect(h.showToast).not.toHaveBeenCalled();
    expect(onLinksChange).not.toHaveBeenCalled();
  });

  it('a non-ActionError on remove toasts (runAction never saw it)', async () => {
    h.removeWispLink.mockRejectedValue(new Error('chunk load failed'));
    render(<WispLinksPanel threadId="th-1" links={[link('1')]} onLinksChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('wisp-link-remove-1'));
    await waitFor(() => expect(h.showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
  });

  it('Add opens the picker with the linked keys; a new link is appended once and the picker closes', () => {
    const onLinksChange = vi.fn();
    render(<WispLinksPanel threadId="th-1" links={[link('1')]} onLinksChange={onLinksChange} />);
    fireEvent.click(screen.getByTestId('wisp-links-add'));
    expect(screen.getByTestId('wisp-entity-picker-mock')).toBeInTheDocument();
    expect(h.pickerProps?.threadId).toBe('th-1');
    expect((h.pickerProps?.linkedKeys as Set<string>).has('ticket:t-1')).toBe(true);
    act(() => (h.pickerProps?.onLinked as (l: WispThreadLink) => void)(link('3')));
    expect(onLinksChange).toHaveBeenCalledWith([expect.objectContaining({ id: '1' }), expect.objectContaining({ id: '3' })]);
    expect(screen.queryByTestId('wisp-entity-picker-mock')).toBeNull();
  });

  it('an idempotent re-add (same link id) is not duplicated', () => {
    const onLinksChange = vi.fn();
    render(<WispLinksPanel threadId="th-1" links={[link('1')]} onLinksChange={onLinksChange} />);
    fireEvent.click(screen.getByTestId('wisp-links-add'));
    act(() => (h.pickerProps?.onLinked as (l: WispThreadLink) => void)(link('1', { label: 'refreshed' })));
    expect(onLinksChange).toHaveBeenCalledWith([expect.objectContaining({ id: '1', label: 'refreshed' })]);
  });

  it('Add is disabled while the grant cannot add (paused/ended)', () => {
    render(<WispLinksPanel threadId="th-1" links={[link('1')]} onLinksChange={vi.fn()} canAdd={false} />);
    expect(screen.getByTestId('wisp-links-add')).toBeDisabled();
  });

  it.each(['concern', 'auto'] as const)('50 %s rows do not disable Add', (source) => {
    const rows = Array.from({ length: 50 }, (_, i) => link(String(i), { source, ...(source === 'concern' ? { id: null } : {}) }));
    render(<WispLinksPanel threadId="th-1" links={rows} onLinksChange={vi.fn()} />);
    expect(screen.getByTestId('wisp-links-add')).toBeEnabled();
    expect(screen.getByTestId('wisp-links-count')).toHaveTextContent('0 of 50 linked');
    fireEvent.click(screen.getByTestId('wisp-links-add'));
    expect(screen.getByTestId('wisp-entity-picker-mock')).toBeInTheDocument();
  });

  it('50 pins disable Add', () => {
    const pins = Array.from({ length: 50 }, (_, i) => link(String(i), { source: i % 2 ? 'wisp_pin' : 'user_pin' }));
    render(<WispLinksPanel threadId="th-1" links={pins} onLinksChange={vi.fn()} />);
    expect(screen.getByTestId('wisp-links-add')).toBeDisabled();
    expect(screen.getByTestId('wisp-links-count')).toHaveTextContent('50 of 50 linked');
  });
});

it('groups pins, concerns and recent, shows 12 then More', () => {
  const rows = [link('auto', { source: 'auto' }), link('concern', { id: null, source: 'concern' }), ...Array.from({ length: 12 }, (_, i) => link(String(i)))];
  render(<WispLinksPanel threadId="th-1" links={rows} onLinksChange={vi.fn()} />);
  expect(screen.getAllByTestId(/^wisp-link-chip-/)).toHaveLength(12);
  fireEvent.click(screen.getByTestId('wisp-links-more'));
  expect(screen.getAllByTestId(/^wisp-link-chip-/)).toHaveLength(14);
  expect(screen.getAllByTestId(/^wisp-links-group-/).map((el) => el.dataset.testid)).toEqual(['wisp-links-group-pinned', 'wisp-links-group-concerns', 'wisp-links-group-recent']);
});

it('merges a pinned concern by kind:id and excludes derived rows from picker linkedKeys', () => {
  const concern = link('1', { id: null, source: 'concern' });
  const onLinksChange = vi.fn();
  render(<WispLinksPanel threadId="th-1" links={[concern, link('2', { id: null, source: 'concern' })]} onLinksChange={onLinksChange} />);
  expect((h.pickerProps?.linkedKeys as Set<string>).size).toBe(0);
  act(() => (h.pickerProps?.onLinked as (l: WispThreadLink) => void)(link('new', { ref: concern.ref })));
  expect(onLinksChange).toHaveBeenCalledWith([expect.objectContaining({ id: 'new' }), expect.objectContaining({ id: null, label: '#102 Printer jam' })]);
});

it('pin moves an auto into the pins group; dismiss deletes an auto', async () => {
  h.removeWispLink.mockResolvedValue(undefined);
  const auto = link('1', { source: 'auto' });
  h.pinWispLink.mockResolvedValue(link('1'));
  const changed = vi.fn();
  const view = render(<WispLinksPanel threadId="th-1" links={[auto]} onLinksChange={changed} />);
  fireEvent.click(screen.getByTestId('wisp-link-pin-1'));
  await waitFor(() => expect(changed).toHaveBeenCalledWith([expect.objectContaining({ source: 'user_pin' })]));
  expect(h.pinWispLink).toHaveBeenCalledWith('th-1', '1');
  view.rerender(<WispLinksPanel threadId="th-1" links={[link('1')]} onLinksChange={changed} />);
  expect(screen.getByTestId('wisp-links-group-pinned')).toContainElement(screen.getByTestId('wisp-link-chip-1'));
  view.rerender(<WispLinksPanel threadId="th-1" links={[auto]} onLinksChange={changed} />);
  fireEvent.click(screen.getByTestId('wisp-link-dismiss-1'));
  await waitFor(() => expect(changed).toHaveBeenCalledWith([]));
});
