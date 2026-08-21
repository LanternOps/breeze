import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useToastRailOffset } from './toastRailOffset';

// #2151 — the toast lift used to be a flat `lg:bottom-24` baked into the shared
// ToastContainer, so one page's right rail moved every page's toasts. It is now
// opt-in: the page with the rail stamps `data-toast-rail` on <html> for as long
// as it is mounted, and globals.css raises --breeze-toast-bottom off that.

function Rail() {
  useToastRailOffset();
  return <div data-testid="rail" />;
}

const railOffsetSet = () => document.documentElement.hasAttribute('data-toast-rail');

describe('useToastRailOffset', () => {
  afterEach(() => document.documentElement.removeAttribute('data-toast-rail'));

  it('does not lift the anchor for a page that never opts in', () => {
    render(<div data-testid="plain" />);
    expect(railOffsetSet()).toBe(false);
  });

  it('lifts the anchor while mounted and drops it on unmount', () => {
    const { unmount } = render(<Rail />);
    expect(railOffsetSet()).toBe(true);

    unmount();
    expect(railOffsetSet()).toBe(false);
  });

  it('keeps the lift while a second holder is still mounted (refcounted)', () => {
    // Two rail-bearing trees can overlap — e.g. a remount whose old tree has not
    // finished tearing down. A naive set/remove would drop the offset out from
    // under the survivor the moment the first one unmounted.
    const first = render(<Rail />);
    const second = render(<Rail />);
    expect(railOffsetSet()).toBe(true);

    first.unmount();
    expect(railOffsetSet()).toBe(true);

    second.unmount();
    expect(railOffsetSet()).toBe(false);
  });
});
