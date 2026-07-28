// The save-grammar itself. Every consumer's test asserts that a cue APPEARS;
// none of them advance a clock, so the 1500ms clear and the unmount teardown —
// the two things this module owns outright — were unguarded. A `setTimeout(…,
// 15000)` typo would have passed the entire suite with a "Saved" badge stuck on
// screen for fifteen seconds.
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSavedFlash, SrSaved, fieldRing, seamless, unsavedHintId } from './saveCues';

function Harness() {
  const [on, flash] = useSavedFlash();
  return (
    <>
      <button type="button" onClick={flash} data-testid="flash">flash</button>
      <SrSaved show={on} label="Saved" testId="cue" />
    </>
  );
}

afterEach(() => { vi.useRealTimers(); });

describe('useSavedFlash', () => {
  it('shows the cue on flash and clears it after 1500ms', async () => {
    // Fully controlled fake time. `shouldAdvanceTime` also ticks with REAL
    // time, so advancing to 1_499 can cross 1_500 under a loaded full-suite run
    // — a flaky boundary on the one assertion that gives this test its value.
    vi.useFakeTimers();
    render(<Harness />);
    expect(screen.getByTestId('cue')).toHaveTextContent('');

    act(() => { screen.getByTestId('flash').click(); });
    expect(screen.getByTestId('cue')).toHaveTextContent('Saved');

    // Just before the window closes it is still up…
    await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
    expect(screen.getByTestId('cue')).toHaveTextContent('Saved');

    // …and it clears on its own, with no further interaction.
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByTestId('cue')).toHaveTextContent('');
  });

  it('re-flashing restarts the window rather than letting the first timer clear it early', async () => {
    vi.useFakeTimers();
    render(<Harness />);

    act(() => { screen.getByTestId('flash').click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => { screen.getByTestId('flash').click(); });

    // The first timer would have fired here; the restart must have cancelled it.
    await act(async () => { await vi.advanceTimersByTimeAsync(600); });
    expect(screen.getByTestId('cue')).toHaveTextContent('Saved');

    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(screen.getByTestId('cue')).toHaveTextContent('');
  });

  it('clears its timer on unmount so a late fire cannot setState a gone node', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    try {
      const { unmount } = render(<Harness />);
      act(() => { screen.getByTestId('flash').click(); });
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SrSaved', () => {
  it('is a live region whose CONTENT swaps — the span must not mount/unmount', () => {
    // A conditionally-mounted live region announces nothing: AT has to be
    // observing the node before its text changes.
    const { rerender } = render(<SrSaved show={false} label="Saved" testId="cue" />);
    const node = screen.getByTestId('cue');
    expect(node).toHaveAttribute('role', 'status');
    // role="status" already implies aria-live=polite; doubling it is redundant.
    expect(node).not.toHaveAttribute('aria-live');
    expect(node).toHaveTextContent('');

    rerender(<SrSaved show label="Saved" testId="cue" />);
    expect(screen.getByTestId('cue')).toBe(node); // same node, new content
    expect(node).toHaveTextContent('Saved');
  });
});

describe('fieldRing', () => {
  it('emits border-COLOR classes only, so a caller without a border width renders nothing', () => {
    // Pins the precondition documented in saveCues: these are colours, and
    // Tailwind's preflight leaves border-width at 0. A call site that drops its
    // `border` utility silently loses the cue — which is exactly what happened
    // to the rich-text block card in the ring→border migration.
    expect(fieldRing(true, false)).toBe('border-warning-strong');
    expect(fieldRing(false, true)).toBe('border-success');
    expect(fieldRing(false, false)).toBe('');
    for (const cls of [fieldRing(true, false), fieldRing(false, true)]) {
      expect(cls).not.toMatch(/\bborder-\d|\bring-/);
    }
  });

  it('gives dirty precedence over saved — the pair is reachable, not nonsense', () => {
    // flashSaved() holds `saved` for 1500ms, during which the user can type
    // again. Unsaved work outranks a stale confirmation.
    expect(fieldRing(true, true)).toBe('border-warning-strong');
  });
});

describe('seamless', () => {
  it('always carries a focus-visible ring, including in the invalid state', () => {
    // These fields set focus:outline-hidden, so this ring is the ONLY focus
    // indicator. The invalid branch used to be written as a caller-side ternary
    // that bypassed seamless entirely, leaving the one field a keyboard user is
    // trying to fix with no indicator at all.
    for (const cls of [seamless(''), seamless('border-warning-strong'), seamless('', true), seamless('border-warning-strong', true)]) {
      expect(cls).toContain('focus-visible:ring-2');
      expect(cls).toContain('focus-visible:ring-ring');
    }
  });

  it('lets one border-color win: state replaces the base set, invalid replaces state', () => {
    expect(seamless('')).toContain('border-transparent');
    expect(seamless('border-warning-strong')).not.toContain('border-transparent');
    expect(seamless('border-warning-strong', true)).toContain('border-destructive');
    expect(seamless('border-warning-strong', true)).not.toContain('border-warning-strong');
  });
});

describe('unsavedHintId', () => {
  it('namespaces by surface so the quote and invoice editors cannot collide', () => {
    // All three params are strings, so a swapped argument compiles cleanly —
    // exact-string assertions are the only thing that catches it.
    expect(unsavedHintId('quote-line', 'line-1', 'qty')).toBe('quote-line-qty-unsaved-line-1');
    expect(unsavedHintId('invoice-line', 'line-1', 'qty')).toBe('invoice-line-qty-unsaved-line-1');
    expect(unsavedHintId('quote-line', 'line-1', 'qty'))
      .not.toBe(unsavedHintId('invoice-line', 'line-1', 'qty'));
  });
});
