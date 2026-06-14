import { describe, expect, it } from 'vitest';
import { formatMinutes, formatElapsedSeconds, formatMoney } from '../timeFormat';

describe('formatMinutes', () => {
  it('renders sub-hour as minutes', () => expect(formatMinutes(45)).toBe('45m'));
  it('renders exact hours without minutes', () => expect(formatMinutes(120)).toBe('2h'));
  it('renders mixed', () => expect(formatMinutes(90)).toBe('1h 30m'));
  it('treats null/negative as zero', () => {
    expect(formatMinutes(null)).toBe('0m');
    expect(formatMinutes(-5)).toBe('0m');
  });
});

describe('formatElapsedSeconds', () => {
  it('renders mm:ss under an hour', () => expect(formatElapsedSeconds(125)).toBe('02:05'));
  it('renders h:mm:ss over an hour', () => expect(formatElapsedSeconds(3725)).toBe('1:02:05'));
});

describe('formatMoney', () => {
  it('formats numeric strings from the API', () => expect(formatMoney('1234.5')).toBe('$1,234.50'));
  it('falls back to $0.00 on garbage', () => expect(formatMoney('not-a-number')).toBe('$0.00'));
});
