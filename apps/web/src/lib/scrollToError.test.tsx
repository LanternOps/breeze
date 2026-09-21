import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollErrorIntoView, useScrollToError } from './scrollToError';

describe('scrollErrorIntoView (#6494)', () => {
  it('scrolls the element into view and focuses it', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const scrollIntoView = vi.fn();
    el.scrollIntoView = scrollIntoView;
    const focus = vi.spyOn(el, 'focus');

    scrollErrorIntoView(el);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(focus).toHaveBeenCalled();
    expect(el.getAttribute('tabindex')).toBe('-1');
  });

  it('does nothing when the element is null', () => {
    expect(() => scrollErrorIntoView(null)).not.toThrow();
  });

  it('does not override an existing tabindex', () => {
    const el = document.createElement('div');
    el.setAttribute('tabindex', '0');
    el.scrollIntoView = vi.fn();
    scrollErrorIntoView(el);
    expect(el.getAttribute('tabindex')).toBe('0');
  });
});

function Probe({ error }: { error: string | undefined }) {
  const ref = useScrollToError<HTMLDivElement>(error);
  return <div ref={ref} data-testid="error-banner">{error}</div>;
}

describe('useScrollToError (#6494)', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    // jsdom has no scrollIntoView implementation; stub it on the prototype so
    // every element created during these tests has one.
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
  });

  it('scrolls the ref element into view when the error first appears', () => {
    const { rerender } = render(<Probe error={undefined} />);
    expect(scrollIntoView).not.toHaveBeenCalled();

    rerender(<Probe error="Name is required" />);

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('does not scroll again on re-render while the error stays truthy', () => {
    const { rerender } = render(<Probe error={undefined} />);
    rerender(<Probe error="Name is required" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(<Probe error="Name is required" />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('scrolls again if the error clears and a new one appears', () => {
    const { rerender } = render(<Probe error={undefined} />);
    rerender(<Probe error="Name is required" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(<Probe error={undefined} />);
    rerender(<Probe error="Sources are required" />);

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('scrolls again when a different error replaces the current one with no intervening clear', () => {
    // Regression guard: a caller that goes straight from one truthy error
    // string to a different truthy error string in the same handler (e.g.
    // two sequential validation checks that each call setError and return,
    // never routing through undefined) still must re-trigger the scroll —
    // React batches same-tick setState calls, so this can't rely on a
    // falsy->truthy boolean transition ever being observed.
    const { rerender } = render(<Probe error={undefined} />);
    rerender(<Probe error="A reason is required." />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    rerender(<Probe error="Immutable days must be at least 1." />);

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('does not scroll on an identical error value even if re-set', () => {
    const { rerender } = render(<Probe error={undefined} />);
    rerender(<Probe error="Name is required" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Same string value (e.g. a new render triggered by unrelated state).
    rerender(<Probe error="Name is required" />);

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
