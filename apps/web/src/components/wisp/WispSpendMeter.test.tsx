import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import WispSpendMeter from './WispSpendMeter';

const RESETS = new Date(Date.now() + 6 * 3600_000 - 60_000).toISOString();

describe('WispSpendMeter (W06 T15, w00 A32)', () => {
  it('shows spent of budget and the reset in hours', () => {
    render(<WispSpendMeter spentCents={42} budgetCents={200} resetsAt={RESETS} onRaise={vi.fn()} />);
    const meter = screen.getByTestId('wisp-spend-meter');
    expect(meter.getAttribute('data-state')).toBe('ok');
    expect(meter.textContent).toContain('$0.42 of $2.00 today');
    expect(meter.textContent).not.toContain('¢');
    expect(meter.textContent).toContain('6');
    expect(screen.queryByTestId('wisp-spend-raise')).toBeNull();
  });

  it('turns amber at 80 %', () => {
    render(<WispSpendMeter spentCents={160} budgetCents={200} resetsAt={RESETS} onRaise={vi.fn()} />);
    expect(screen.getByTestId('wisp-spend-meter').getAttribute('data-state')).toBe('warn');
  });

  it('at 100 % offers the one-tap raise the exhausted-budget notice points at', () => {
    const onRaise = vi.fn();
    render(<WispSpendMeter spentCents={200} budgetCents={200} resetsAt={RESETS} onRaise={onRaise} />);
    expect(screen.getByTestId('wisp-spend-meter').getAttribute('data-state')).toBe('exhausted');
    fireEvent.click(screen.getByTestId('wisp-spend-raise'));
    expect(onRaise).toHaveBeenCalledTimes(1);
  });

  it('with no onRaise (raising cannot help) the exhausted meter shows no raise link (#10145)', () => {
    render(<WispSpendMeter spentCents={200} budgetCents={200} resetsAt={RESETS} />);
    expect(screen.getByTestId('wisp-spend-meter').getAttribute('data-state')).toBe('exhausted');
    expect(screen.queryByTestId('wisp-spend-raise')).toBeNull();
  });
});
