import { render, screen, fireEvent } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import AiBudgetThresholdsInput from './AiBudgetThresholdsInput';

/**
 * Records the input's committed DOM value. Layout effects run synchronously in
 * the mutation phase of the very commit that produced the DOM, so this reads
 * what the box actually showed at that commit without depending on when
 * React's scheduler gets around to passive effects.
 *
 * It appends once per commit that re-renders THIS probe — i.e. once per
 * `rerender()` from the test, not once per commit anywhere in the tree. That
 * is exactly the question being asked: did the commit carrying the new prop
 * already show the new ladder, or did the box need a later, box-local commit
 * to catch up?
 *
 * Deliberately unguarded: if the selector ever stops matching, this throws with
 * the reason rather than quietly recording one fewer entry.
 */
function CommitProbe({ testId, seen }: { testId: string; seen: string[] }) {
  useLayoutEffect(() => {
    const el = document.querySelector(`[data-testid="${testId}-input"]`);
    if (!el) throw new Error(`CommitProbe: no element matching [data-testid="${testId}-input"]`);
    seen.push((el as HTMLInputElement).value);
  });
  return null;
}

describe('AiBudgetThresholdsInput', () => {
  it('renders current rungs as chips and emits a normalised list on blur', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50, 80]} onChange={onChange} testId="thresholds" />);
    expect(screen.getByText('50%')).toBeInTheDocument();
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '95, 50, 80' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([50, 80, 95]);
  });

  it('rejects values outside 1..99 with an inline error and does not emit', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits undefined (inherit) when cleared', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50]} onChange={onChange} testId="thresholds" />);
    fireEvent.change(screen.getByTestId('thresholds-input'), { target: { value: '' } });
    fireEvent.blur(screen.getByTestId('thresholds-input'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it('rejects more than five values with an inline error and does not emit', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '10, 20, 30, 40, 50, 60' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('dedupes duplicate values within the same input', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '50, 50, 80' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([50, 80]);
  });

  it('commits on Enter without requiring blur', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '50, 80' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([50, 80]);
  });

  it('clears a stale inline error as soon as the user edits the text again', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '50' } });
    expect(screen.queryByTestId('thresholds-error')).not.toBeInTheDocument();
  });

  // The commit path swallows unparseable text (no onChange), so the page above
  // has no other way to know its Save button would persist the stale value.
  it('reports invalid on an unparseable entry and valid again once it parses', () => {
    const onValidityChange = vi.fn();
    render(
      <AiBudgetThresholdsInput value={[]} onChange={vi.fn()} onValidityChange={onValidityChange} testId="thresholds" />,
    );
    const input = screen.getByTestId('thresholds-input');

    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'thresholds-error');
    expect(screen.getByTestId('thresholds-error')).toHaveAttribute('id', 'thresholds-error');

    fireEvent.change(input, { target: { value: '50, 80' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('releases the caller when it unmounts holding unparseable text', () => {
    const onValidityChange = vi.fn();
    const { unmount } = render(
      <AiBudgetThresholdsInput value={[]} onChange={vi.fn()} onValidityChange={onValidityChange} testId="thresholds" />,
    );
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    unmount();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it('does not commit a disabled input', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50]} onChange={onChange} disabled testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  // #4659 / #4601: the box used to seed itself from `value` in a `useEffect`,
  // i.e. in a commit AFTER the one that delivered the new prop. Because a
  // passive effect is deferred, its `setText` could land after the user had
  // already typed, writing the effect's captured string over the keystroke —
  // the next blur then committed the PRE-EDIT ladder.
  //
  // That window is not hypothetical: @testing-library's `asyncWrapper` turns
  // the act environment OFF for the duration of `waitFor`/`findBy*` and drains
  // with `setTimeout(0)`, which under CI load loses the race against React's
  // scheduler. On real CI it surfaced in `AiUsagePage` as a PUT carrying
  // `[50, 80, 95]` where the test had cleared the field, and `null` where it
  // had typed `60, 90` — always the value the box held at mount.
  //
  // Seeding during render closes the window: there is no commit in which the
  // box still shows the old ladder, so assert exactly that.
  it('re-seeds a changed value prop within the same commit, not a later one (#4659)', () => {
    const seen: string[] = [];
    const view = (value: number[]) => (
      <>
        <AiBudgetThresholdsInput value={value} onChange={vi.fn()} testId="thresholds" />
        <CommitProbe testId="thresholds" seen={seen} />
      </>
    );

    const { rerender } = render(view([50, 80]));
    seen.length = 0;

    rerender(view([60, 90]));

    // One commit, already showing the new ladder. Two entries starting with
    // '50, 80' is the old effect-driven seed, and is what made the box
    // clobberable mid-keystroke.
    expect(seen).toEqual(['60, 90']);
  });

  // The seed is compared as the RENDERED string, not by array identity, so a
  // refetch that returns an equal-but-new `[50, 80]` — which changes nothing on
  // screen — cannot throw away what the user is still typing. The old `[value]`
  // effect dependency was identity-based and did exactly that.
  it('keeps a draft when a refetch hands back an equal-but-new value array (#4659)', () => {
    const onChange = vi.fn();
    const view = (value: number[]) => (
      <AiBudgetThresholdsInput value={value} onChange={onChange} testId="thresholds" />
    );

    const { rerender } = render(view([50, 80]));
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '60, 90' } });

    rerender(view([50, 80]));

    expect(input.value).toBe('60, 90');
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([60, 90]);
  });

  // The other half of the render/effect split this change introduced. The
  // render-phase reset clears `invalid` but cannot notify the caller from
  // inside a render, so a reconciling effect does it. Without this test a
  // future simplification could drop that effect and leave a caller's Save
  // button disabled forever after a legitimate external reset.
  it('releases the caller when value resets over unparseable text (#4659)', () => {
    const onValidityChange = vi.fn();
    const view = (value: number[]) => (
      <AiBudgetThresholdsInput value={value} onChange={vi.fn()} onValidityChange={onValidityChange} testId="thresholds" />
    );

    const { rerender } = render(view([50, 80]));
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    onValidityChange.mockClear();
    rerender(view([60, 90]));

    expect(input.value).toBe('60, 90');
    expect(screen.queryByTestId('thresholds-error')).not.toBeInTheDocument();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  // The motivating scenario stated positively: `AiUsagePage` re-renders this
  // box whenever any OTHER budget field is edited, passing the same
  // `alertThresholdPercents` reference through. An uncommitted keystroke has to
  // survive that.
  it('does not clobber uncommitted text across an unrelated re-render (#4659)', () => {
    const value = [50, 80];
    const view = (placeholder: string) => (
      <AiBudgetThresholdsInput value={value} onChange={vi.fn()} placeholder={placeholder} testId="thresholds" />
    );

    const { rerender } = render(view('first'));
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '60, 90' } });

    rerender(view('second'));

    expect(input.value).toBe('60, 90');
  });

  // `value?.join(', ') ?? ''` and the chip list both special-case undefined;
  // every other prop-transition test here uses a defined array.
  it('re-seeds to empty when value resets to undefined', () => {
    const view = (value: number[] | undefined) => (
      <AiBudgetThresholdsInput value={value} onChange={vi.fn()} testId="thresholds" />
    );

    const { rerender } = render(view([50, 80]));
    expect(screen.getByText('50%')).toBeInTheDocument();

    rerender(view(undefined));

    expect((screen.getByTestId('thresholds-input') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('50%')).not.toBeInTheDocument();
  });
});
