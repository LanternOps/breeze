import { describe, expect, it } from 'vitest';
import { formatCentsPerM, formatContextTokens } from './modelPickerFormat';

describe('modelPickerFormat', () => {
  it.each([[1_000_000, '1M'], [200_000, '200K'], [128_000, '128K'], [1_500_000, '1.5M'], [null, null]])('context %s → %s', (n, s) => {
    expect(formatContextTokens(n)).toBe(s);
  });
  it.each([[300, '$3'], [75, '$0.75'], [1250, '$12.50'], [0, '$0']])('price %s¢/M → %s', (c, s) => {
    expect(formatCentsPerM(c)).toBe(s);
  });
});
