import { describe, expect, it } from 'vitest';

import { distanceFromBottom, shouldAutoFollow, STICK_THRESHOLD_PX } from './autoFollow';

describe('shouldAutoFollow', () => {
  it('always follows a newly sent user message, even when scrolled away', () => {
    expect(shouldAutoFollow({ sentNewUserMessage: true, nearBottom: false })).toBe(true);
  });

  it('follows streaming growth only while the user is near the bottom', () => {
    expect(shouldAutoFollow({ sentNewUserMessage: false, nearBottom: true })).toBe(true);
    expect(shouldAutoFollow({ sentNewUserMessage: false, nearBottom: false })).toBe(false);
  });
});

describe('distanceFromBottom', () => {
  it('measures the gap below the viewport', () => {
    expect(
      distanceFromBottom({ contentOffsetY: 100, contentHeight: 1000, layoutHeight: 600 }),
    ).toBe(300);
    expect(STICK_THRESHOLD_PX).toBeGreaterThan(0);
  });
});
