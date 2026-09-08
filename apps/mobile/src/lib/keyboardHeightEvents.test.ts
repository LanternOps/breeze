import { describe, expect, it } from 'vitest';

import { keyboardHideEventName, keyboardShowEventName } from './keyboardHeightEvents';

// #5171: iOS reports the keyboard's final frame ahead of the animation via
// `keyboardWillShow`/`keyboardWillHide`, so tracking that height keeps the
// toast offset in step with the keyboard as it slides in. Android has no
// "will" pair at all — only `keyboardDidShow`/`keyboardDidHide`, fired once
// the keyboard has already finished animating. Picking the wrong pair per
// platform either misses the event entirely (Android has no "will") or lags
// a full animation behind (iOS "did").
describe('keyboardShowEventName', () => {
  it('uses the pre-animation event on iOS', () => {
    expect(keyboardShowEventName('ios')).toBe('keyboardWillShow');
  });

  it('falls back to the post-animation event on every other platform', () => {
    expect(keyboardShowEventName('android')).toBe('keyboardDidShow');
    expect(keyboardShowEventName('web')).toBe('keyboardDidShow');
  });
});

describe('keyboardHideEventName', () => {
  it('uses the pre-animation event on iOS', () => {
    expect(keyboardHideEventName('ios')).toBe('keyboardWillHide');
  });

  it('falls back to the post-animation event on every other platform', () => {
    expect(keyboardHideEventName('android')).toBe('keyboardDidHide');
    expect(keyboardHideEventName('web')).toBe('keyboardDidHide');
  });
});
