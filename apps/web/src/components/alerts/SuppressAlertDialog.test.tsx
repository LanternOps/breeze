import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SuppressAlertDialog from './SuppressAlertDialog';

const onConfirm = vi.fn();
const onCancel = vi.fn();

const renderDialog = () =>
  render(<SuppressAlertDialog alertTitle="Warranty expires in 5 days: MacBook-Pro-3" onConfirm={onConfirm} onCancel={onCancel} />);

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

  it('confirms the Forever option as null (indefinite suppression)', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('suppress-duration-forever'));
    fireEvent.click(screen.getByTestId('suppress-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    // null signals "no until" — the endpoint leaves suppressedUntil unset.
    expect(onConfirm.mock.calls[0][0]).toBeNull();
  });

  it('cancels without confirming', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('suppress-cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // #3964: the single-alert prompt wrapped the title in the locale values
  // "&ldquo;"/"&rdquo;". React text-escapes the leading `&`, so those reached
  // the user as the literal strings rather than curly quotes.
  it('quotes the alert title with real curly quotes, not HTML entities', () => {
    renderDialog();
    const prompt = screen.getByText(/stay suppressed\?/);

    expect(prompt.textContent).toBe(
      'How long should \u201cWarranty expires in 5 days: MacBook-Pro-3\u201d stay suppressed?',
    );
    expect(prompt.textContent).not.toContain('&ldquo;');
    expect(prompt.textContent).not.toContain('&rdquo;');
  });

  it('shows bulk copy when a count > 1 is given', () => {
    render(<SuppressAlertDialog count={5} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.getByText(/these 5 alerts stay suppressed/i)).toBeInTheDocument();
  });

  it('offers a Forever radio alongside the timed presets', () => {
    renderDialog();
    expect(screen.getByRole('radio', { name: /Forever/i })).toBe(
      screen.getByTestId('suppress-duration-forever'),
    );
  });

  it('labels the duration fieldset with a legend', () => {
    renderDialog();
    expect(screen.getByRole('group', { name: /Suppression duration/i })).toBeInTheDocument();
  });
});
