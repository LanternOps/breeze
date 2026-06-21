import { describe, expect, it } from 'vitest';

import { BOTTOM_PIN_THRESHOLD_PX, shouldAutoScroll } from './aiChatScroll';

describe('shouldAutoScroll (#1713 AI chat bottom-pinning)', () => {
  it('pins when exactly at the bottom', () => {
    expect(shouldAutoScroll(0)).toBe(true);
  });

  it('pins when within the threshold slack of the bottom', () => {
    expect(shouldAutoScroll(BOTTOM_PIN_THRESHOLD_PX - 1)).toBe(true);
    expect(shouldAutoScroll(BOTTOM_PIN_THRESHOLD_PX)).toBe(true);
  });

  it('does not pin once the user has scrolled up past the threshold', () => {
    expect(shouldAutoScroll(BOTTOM_PIN_THRESHOLD_PX + 1)).toBe(false);
    expect(shouldAutoScroll(500)).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(shouldAutoScroll(10, 5)).toBe(false);
    expect(shouldAutoScroll(10, 20)).toBe(true);
  });

  it('treats an unmeasurable (non-finite) distance as pinned so first paint anchors', () => {
    // A not-yet-laid-out container yields NaN/Infinity; both are non-finite and
    // must fall back to "pinned" so the initial render still anchors to bottom.
    expect(shouldAutoScroll(Number.NaN)).toBe(true);
    expect(shouldAutoScroll(Number.POSITIVE_INFINITY)).toBe(true);
  });
});
