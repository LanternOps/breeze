import { describe, it, expect } from 'vitest';

import { formatElapsed, formatMinutes } from './timeFormat';

describe('formatElapsed', () => {
  it('renders HH:MM:SS zero-padded', () => {
    expect(formatElapsed(0)).toBe('00:00:00');
    expect(formatElapsed(9)).toBe('00:00:09');
    expect(formatElapsed(150)).toBe('00:02:30');
    expect(formatElapsed(3661)).toBe('01:01:01');
  });

  it('keeps counting past a day rather than wrapping to zero', () => {
    // A timer left running overnight is a real (and expensive) field mistake.
    // Wrapping to 00:00:0x would hide it at the exact moment it matters.
    expect(formatElapsed(90000)).toBe('25:00:00');
  });

  it('never renders a negative clock', () => {
    expect(formatElapsed(-30)).toBe('00:00:00');
    expect(formatElapsed(Number.NaN)).toBe('00:00:00');
  });
});

describe('formatMinutes', () => {
  it('renders bare minutes under an hour', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
  });

  it('renders hours and zero-padded minutes at or above an hour', () => {
    expect(formatMinutes(60)).toBe('1h 00m');
    expect(formatMinutes(65)).toBe('1h 05m');
    expect(formatMinutes(605)).toBe('10h 05m');
  });

  it('treats a missing duration as a dash, not as zero', () => {
    // A running entry has durationMinutes: null. Showing "0m" would claim the
    // technician has logged nothing on it.
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(undefined)).toBe('—');
  });
});
