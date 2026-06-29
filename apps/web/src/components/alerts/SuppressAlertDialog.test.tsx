import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SuppressAlertDialog from './SuppressAlertDialog';

const onConfirm = vi.fn();
const onCancel = vi.fn();

const renderDialog = () =>
  render(<SuppressAlertDialog alertTitle="Warranty expires in 5 days: MacBook-Pro-3" onConfirm={onConfirm} onCancel={onCancel} />);

// A local wall-clock string in the datetime-local format (YYYY-MM-DDTHH:mm).
const localInputValue = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

describe('SuppressAlertDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('confirms the default 24h preset as an absolute future Date', () => {
    renderDialog();
    const before = Date.now();
    fireEvent.click(screen.getByTestId('suppress-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const until = onConfirm.mock.calls[0][0] as Date;
    expect(until).toBeInstanceOf(Date);
    expect(until.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000 - 1000);
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60 * 1000 + 1000);
  });

  it('confirms a selected preset (1h)', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('suppress-duration-1h'));
    const before = Date.now();
    fireEvent.click(screen.getByTestId('suppress-confirm'));

    const until = onConfirm.mock.calls[0][0] as Date;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000 - 1000);
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000 + 1000);
  });

  it('converts a custom local datetime to the matching absolute instant', () => {
    renderDialog();
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const value = localInputValue(future);
    fireEvent.change(screen.getByTestId('suppress-duration-custom-input'), { target: { value } });
    fireEvent.click(screen.getByTestId('suppress-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const until = onConfirm.mock.calls[0][0] as Date;
    // The emitted instant must equal the local wall-clock the user entered
    // (this is where a local→UTC off-by-offset bug would surface).
    expect(until.getTime()).toBe(new Date(value).getTime());
  });

  it('rejects a past custom time with an inline error and does not confirm', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('suppress-duration-custom-input'), {
      target: { value: '2000-01-01T00:00' },
    });
    fireEvent.click(screen.getByTestId('suppress-confirm'));

    expect(screen.getByTestId('suppress-duration-error')).toHaveTextContent(/future/i);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('rejects an empty custom selection with an inline error', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('suppress-duration-custom'));
    fireEvent.click(screen.getByTestId('suppress-confirm'));

    expect(screen.getByTestId('suppress-duration-error')).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels without confirming', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('suppress-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
