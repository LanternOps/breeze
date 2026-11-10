/**
 * Wisp check-in timers W05 (#10996) Task 13: the "Wisp will check back at …"
 * chip under the last turn, one row per scheduled check-in, each with a cancel ×.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { WispCheckIn } from '@breeze/shared';
import WispCheckInChip from './WispCheckInChip';

const at = (h: number, m: number, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d;
};
const checkIn = (id: string, status: WispCheckIn['status'], due: Date): WispCheckIn => ({
  id, threadId: 'th-1', status, dueAt: due.toISOString(), instruction: `do ${id}`, subject: null, firedAt: null, createdAt: new Date().toISOString(),
  trigger: null, fireReason: null, cancelReason: null, mode: 'notify', runId: null,
});
const localTime = (d: Date) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);

describe('WispCheckInChip', () => {
  it('lists only scheduled rows with the local time', () => {
    const due = at(23, 59);
    render(
      <WispCheckInChip
        checkIns={[checkIn('c1', 'scheduled', due), checkIn('c2', 'fired', due), checkIn('c3', 'consumed', due), checkIn('c4', 'cancelled', due)]}
        onCancel={vi.fn()}
      />,
    );
    const rows = screen.getAllByTestId('wisp-check-in-chip');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-check-in-id')).toBe('c1');
    expect(rows[0].textContent).toContain(`Wisp will check back at ${localTime(due)}`);
  });

  it('a check-in due on a later day names the day as well as the time', () => {
    const due = at(9, 5, 3);
    render(<WispCheckInChip checkIns={[checkIn('c1', 'scheduled', due)]} onCancel={vi.fn()} />);
    const expected = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(due);
    expect(screen.getByTestId('wisp-check-in-chip').textContent).toContain(`Wisp will check back at ${expected}`);
  });

  it('× calls onCancel with the id', () => {
    const onCancel = vi.fn();
    render(<WispCheckInChip checkIns={[checkIn('c1', 'scheduled', at(23, 0)), checkIn('c2', 'scheduled', at(23, 30))]} onCancel={onCancel} />);
    const buttons = screen.getAllByTestId('wisp-check-in-cancel');
    expect(buttons[1].getAttribute('aria-label')).toBe('Cancel check-in');
    fireEvent.click(buttons[1]);
    expect(onCancel).toHaveBeenCalledWith('c2');
  });

  it('renders nothing for none', () => {
    const { container } = render(<WispCheckInChip checkIns={[checkIn('c2', 'fired', at(23, 0))]} onCancel={vi.fn()} />);
    expect(container.innerHTML).toBe('');
    const empty = render(<WispCheckInChip checkIns={[]} onCancel={vi.fn()} />);
    expect(empty.container.innerHTML).toBe('');
  });
});
