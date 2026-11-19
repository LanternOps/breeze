import { describe, expect, it } from 'vitest';
import { capRunSummary, RUN_SUMMARY_MAX_CHARS } from './runLoop';

describe('capRunSummary', () => {
  it('cuts an over-long summary at a word boundary with a marker', () => {
    const out = capRunSummary('word '.repeat(1000));
    expect(Array.from(out).length).toBeLessThanOrEqual(RUN_SUMMARY_MAX_CHARS);
    expect(out.endsWith('word…')).toBe(true);
  });

  it('keeps a short summary as is', () => {
    expect(capRunSummary('done')).toBe('done');
  });
});
