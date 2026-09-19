import { describe, it, expect } from 'vitest';

import { isLongEntry, LONG_ENTRY_WARNING_MINUTES } from './timesheetLongEntry';

describe('isLongEntry', () => {
  it('is false for a null duration — the entry is still running', () => {
    expect(isLongEntry(null)).toBe(false);
  });

  it('is false for an undefined duration', () => {
    expect(isLongEntry(undefined)).toBe(false);
  });

  it('is false one minute under the threshold', () => {
    expect(isLongEntry(LONG_ENTRY_WARNING_MINUTES - 1)).toBe(false);
  });

  it('is true at the threshold', () => {
    expect(isLongEntry(LONG_ENTRY_WARNING_MINUTES)).toBe(true);
  });

  it('is true well past the threshold', () => {
    expect(isLongEntry(12 * 60 + 31)).toBe(true);
  });

  it('is false for an ordinary entry', () => {
    expect(isLongEntry(45)).toBe(false);
  });
});
