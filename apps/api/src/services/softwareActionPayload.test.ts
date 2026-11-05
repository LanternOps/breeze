import { describe, expect, it } from 'vitest';
import { softwareActionPayloadSchema } from './softwareActionPayload';

// The agent's validateSoftwareName / validateSoftwareVersion
// (agent/internal/remote/tools/software.go) bound the trimmed value with Go
// `len()`, i.e. UTF-8 BYTES. zod 4.6 counts `.max()` in code points, so the
// API must pin the byte budget itself or it accepts names the agent refuses
// (#9976).
const CJK = '中'; // 3 UTF-8 bytes
const EMOJI = '\u{1F600}'; // 4 UTF-8 bytes

describe('softwareActionPayloadSchema byte budgets', () => {
  it('accepts a 200-byte ASCII name and a 100-byte ASCII version', () => {
    expect(softwareActionPayloadSchema.safeParse({ name: 'a'.repeat(200), version: '1'.repeat(100) }).success).toBe(true);
  });

  it('accepts a non-ASCII name that fits in 200 bytes', () => {
    expect(softwareActionPayloadSchema.safeParse({ name: CJK.repeat(66) }).success).toBe(true);
  });

  it('rejects a name within 200 code points but over 200 UTF-8 bytes', () => {
    expect(softwareActionPayloadSchema.safeParse({ name: CJK.repeat(67) }).success).toBe(false);
    expect(softwareActionPayloadSchema.safeParse({ name: EMOJI.repeat(200) }).success).toBe(false);
  });

  it('rejects a version within 100 code points but over 100 UTF-8 bytes', () => {
    expect(softwareActionPayloadSchema.safeParse({ name: 'App', version: EMOJI.repeat(26) }).success).toBe(false);
    expect(softwareActionPayloadSchema.safeParse({ name: 'App', version: EMOJI.repeat(25) }).success).toBe(true);
  });
});
