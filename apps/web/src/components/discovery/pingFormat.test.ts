import { describe, expect, it } from 'vitest';
import { formatPing, pingColor } from './pingFormat';

describe('formatPing', () => {
  it('renders a dash for a missing reading', () => {
    expect(formatPing(null)).toBe('—');
    expect(formatPing(undefined)).toBe('—');
  });

  it('renders sub-millisecond readings as "<1 ms"', () => {
    expect(formatPing(0.4)).toBe('<1 ms');
  });

  it('renders one decimal place with a unit suffix', () => {
    expect(formatPing(2.4)).toBe('2.4 ms');
    expect(formatPing(120)).toBe('120.0 ms');
  });
});

describe('pingColor', () => {
  it('renders muted for a missing reading', () => {
    expect(pingColor(null)).toBe('text-muted-foreground');
    expect(pingColor(undefined)).toBe('text-muted-foreground');
  });

  it('colors readings under 5ms as the fastest tier, with a dark-theme variant', () => {
    expect(pingColor(4.9)).toBe('text-green-600 dark:text-green-400');
  });

  it('colors readings between 5ms and 50ms as the next tier, with a dark-theme variant', () => {
    expect(pingColor(5)).toBe('text-emerald-600 dark:text-emerald-400');
    expect(pingColor(49.9)).toBe('text-emerald-600 dark:text-emerald-400');
  });

  it('colors readings between 50ms and 200ms as the warning tier, with a dark-theme variant', () => {
    expect(pingColor(50)).toBe('text-yellow-600 dark:text-yellow-400');
    expect(pingColor(199.9)).toBe('text-yellow-600 dark:text-yellow-400');
  });

  it('colors readings at or above 200ms as the slow tier, with a dark-theme variant', () => {
    expect(pingColor(200)).toBe('text-red-600 dark:text-red-400');
    expect(pingColor(2000)).toBe('text-red-600 dark:text-red-400');
  });
});
