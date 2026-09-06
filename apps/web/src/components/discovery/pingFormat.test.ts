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

  it('colors readings under 50ms with the success token', () => {
    expect(pingColor(0)).toBe('text-success');
    expect(pingColor(49.9)).toBe('text-success');
  });

  it('colors readings between 50ms and 150ms with the warning token', () => {
    expect(pingColor(50)).toBe('text-warning');
    expect(pingColor(149.9)).toBe('text-warning');
  });

  it('colors readings at or above 150ms with the destructive token', () => {
    expect(pingColor(150)).toBe('text-destructive');
    expect(pingColor(2000)).toBe('text-destructive');
  });
});
