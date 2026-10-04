import { describe, it, expect } from 'vitest';
import { openPushoverUserKey, sealPushoverUserKey, PUSHOVER_USER_KEY_PATTERN } from './ticketPushover';

describe('per-user Pushover key sealing', () => {
  const KEY = 'u'.repeat(30);

  it('round-trips for the same user and returns null when unset', () => {
    const sealed = sealPushoverUserKey('user-a', KEY);
    expect(openPushoverUserKey('user-a', sealed)).toBe(KEY);
    expect(openPushoverUserKey('user-a', null)).toBeNull();
  });

  it('accepts only 30 letters or digits', () => {
    expect(PUSHOVER_USER_KEY_PATTERN.test(KEY)).toBe(true);
    expect(PUSHOVER_USER_KEY_PATTERN.test('u'.repeat(29))).toBe(false);
    expect(PUSHOVER_USER_KEY_PATTERN.test(`${'u'.repeat(29)}!`)).toBe(false);
  });

  it('refuses ciphertext as input', () => {
    expect(() => sealPushoverUserKey('user-a', 'enc:v1:abc')).toThrow();
  });
});
