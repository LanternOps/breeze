import { describe, expect, it } from 'vitest';

import {
  detectSentUserMessage,
  distanceFromBottom,
  isNearBottom,
  shouldAutoFollow,
  STICK_THRESHOLD_PX,
} from './autoFollow';

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
  });
});

describe('isNearBottom', () => {
  it('treats the threshold as inclusive', () => {
    expect(isNearBottom(STICK_THRESHOLD_PX)).toBe(true);
    expect(isNearBottom(STICK_THRESHOLD_PX + 1)).toBe(false);
  });
});

describe('detectSentUserMessage', () => {
  const u = (id: string) => ({ id, role: 'user' });
  const a = (id: string) => ({ id, role: 'assistant' });

  it('flags a new user message', () => {
    expect(detectSentUserMessage([u('1')], null)).toEqual({ sent: true, userId: '1' });
  });

  it('does not re-flag while the assistant reply streams', () => {
    expect(detectSentUserMessage([u('1'), a('2')], '1')).toEqual({ sent: false, userId: '1' });
  });

  it('flags a later user message', () => {
    expect(detectSentUserMessage([u('1'), a('2'), u('3')], '1')).toEqual({ sent: true, userId: '3' });
  });

  it('still flags when an assistant placeholder lands in the same render', () => {
    expect(detectSentUserMessage([u('1'), a('2'), u('3'), a('4')], '1').sent).toBe(true);
  });

  it('resets on an empty list', () => {
    expect(detectSentUserMessage([], '1')).toEqual({ sent: false, userId: null });
  });
});
