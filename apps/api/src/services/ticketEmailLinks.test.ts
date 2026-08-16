import { describe, it, expect } from 'vitest';
import { normalizeMessageId } from './ticketEmailLinks';

describe('normalizeMessageId', () => {
  it('trims whitespace and preserves angle brackets', () => {
    expect(normalizeMessageId('  <abc@example.com>  ')).toBe('<abc@example.com>');
  });
  it('wraps bare ids in angle brackets', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('<abc@example.com>');
  });
  it('throws on empty input', () => {
    expect(() => normalizeMessageId('   ')).toThrow();
  });
});
