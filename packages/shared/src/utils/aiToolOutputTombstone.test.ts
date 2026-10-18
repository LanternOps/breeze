import { describe, expect, it } from 'vitest';
import { AI_TOOL_OUTPUT_SCRUBBED, isAiToolOutputTombstone } from './aiToolOutputTombstone';

describe('isAiToolOutputTombstone (#8855)', () => {
  it('recognises the retention tombstone', () => {
    expect(AI_TOOL_OUTPUT_SCRUBBED).toBe('scrubbed');
    expect(isAiToolOutputTombstone({ _retention: 'scrubbed', at: '2026-10-01T00:00:00.000Z' })).toBe(true);
  });
  it('rejects anything else', () => {
    for (const v of [undefined, null, 'scrubbed', [], {}, { _retention: 'kept' }, [{ _retention: 'scrubbed' }]]) {
      expect(isAiToolOutputTombstone(v)).toBe(false);
    }
  });
});
