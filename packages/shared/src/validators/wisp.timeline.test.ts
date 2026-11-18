import { describe, expect, it } from 'vitest';
import { wispTimelineQuerySchema } from './wisp';
import { WISP_TIMELINE_DEFAULT_LIMIT, WISP_TIMELINE_MAX_LIMIT } from '../index';

const uuid = '6f1c2b1e-4a7d-4c55-9a35-2d8f5f0e1a01';

describe('wisp timeline constants', () => {
  it('exports the limits from the package barrel', () => {
    expect(WISP_TIMELINE_DEFAULT_LIMIT).toBe(50);
    expect(WISP_TIMELINE_MAX_LIMIT).toBe(100);
  });
});

describe('wispTimelineQuerySchema', () => {
  it('defaults the limit when given no input', () => {
    expect(wispTimelineQuerySchema.parse({})).toEqual({ limit: 50 });
  });
  it('coerces a string limit', () => {
    expect(wispTimelineQuerySchema.parse({ limit: '20' }).limit).toBe(20);
  });
  it('rejects limit 0 and 101, accepts 100', () => {
    expect(wispTimelineQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(wispTimelineQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(wispTimelineQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
  });
  it('validates excludeSessionId as a guid', () => {
    expect(wispTimelineQuerySchema.safeParse({ excludeSessionId: 'not-a-uuid' }).success).toBe(false);
    expect(wispTimelineQuerySchema.safeParse({ excludeSessionId: uuid }).success).toBe(true);
  });
  it('bounds the cursor length', () => {
    expect(wispTimelineQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
    expect(wispTimelineQuerySchema.safeParse({ cursor: 'a'.repeat(513) }).success).toBe(false);
    expect(wispTimelineQuerySchema.safeParse({ cursor: 'a'.repeat(512) }).success).toBe(true);
  });
});
