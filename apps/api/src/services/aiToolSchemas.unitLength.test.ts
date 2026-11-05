import { describe, expect, it } from 'vitest';
import { executeCommandPayloadSchema } from './aiToolSchemas';

// event_logs_query: the agent (remote/tools/eventlogs.go) refuses an XPath
// query over 4096 UTF-8 bytes; zod 4.6 counts `.max(2000)` in code points, so
// 2000 emoji (8000 bytes) passed the API and failed on the device (#9976).
describe('executeCommandPayloadSchema query byte budget', () => {
  const EMOJI = '\u{1F600}'; // 4 UTF-8 bytes

  it('accepts a query that fits the agent byte cap', () => {
    expect(executeCommandPayloadSchema.safeParse({ query: EMOJI.repeat(1024) }).success).toBe(true);
    expect(executeCommandPayloadSchema.safeParse({ query: 'a'.repeat(2000) }).success).toBe(true);
  });

  it('rejects a query within 2000 code points but over 4096 UTF-8 bytes', () => {
    expect(executeCommandPayloadSchema.safeParse({ query: EMOJI.repeat(1025) }).success).toBe(false);
  });
});
