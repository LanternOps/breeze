import { describe, it, expect } from 'vitest';
import { isBenignRejection } from './rejectionSuppressions';

describe('isBenignRejection', () => {
  it('suppresses ProcessTransport-not-ready', () => {
    expect(isBenignRejection(new Error('ProcessTransport is not ready for writing'))).toBe(true);
  });
  it('suppresses AbortError by name', () => {
    const e = new Error('aborted'); e.name = 'AbortError';
    expect(isBenignRejection(e)).toBe(true);
  });
  it('suppresses "Operation aborted" + Transport', () => {
    expect(isBenignRejection(new Error('Operation aborted on Transport'))).toBe(true);
  });
  it('does NOT suppress a real error', () => {
    expect(isBenignRejection(new Error('TypeError: cannot read x of undefined'))).toBe(false);
  });
});
