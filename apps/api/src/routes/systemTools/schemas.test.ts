import { describe, expect, it } from 'vitest';

import {
  AGENT_MAX_FILE_WRITE_BASE64_CHARS,
  AGENT_MAX_FILE_WRITE_BYTES,
  fileUploadBodySchema,
} from './schemas';

// Regression for #2399: the file-browser upload schema must never accept
// content the agent's file_write handler would reject (4MB decoded cap,
// agent/internal/remote/tools/fileops.go MaxFileWriteSize). The agent's WS
// read limit (16MB) is derived from this cap, and an oversized frame kills
// the agent's WebSocket connection instead of being gracefully rejected —
// so the API must enforce the bound before dispatch.
describe('fileUploadBodySchema size caps (#2399)', () => {
  it('matches Go base64.StdEncoding.EncodedLen(4MB)', () => {
    // EncodedLen(n) = ceil(n/3)*4 (StdEncoding, padded)
    expect(AGENT_MAX_FILE_WRITE_BASE64_CHARS).toBe(
      Math.ceil(AGENT_MAX_FILE_WRITE_BYTES / 3) * 4,
    );
    expect(AGENT_MAX_FILE_WRITE_BYTES).toBe(4 * 1024 * 1024);
  });

  it('accepts base64 content up to the encoded 4MB cap', () => {
    const result = fileUploadBodySchema.safeParse({
      path: '/tmp/file.bin',
      content: 'A'.repeat(AGENT_MAX_FILE_WRITE_BASE64_CHARS),
      encoding: 'base64',
    });
    expect(result.success).toBe(true);
  });

  it('rejects base64 content over the encoded 4MB cap', () => {
    const result = fileUploadBodySchema.safeParse({
      path: '/tmp/file.bin',
      content: 'A'.repeat(AGENT_MAX_FILE_WRITE_BASE64_CHARS + 1),
      encoding: 'base64',
    });
    expect(result.success).toBe(false);
  });

  it('accepts text content up to 4MB of UTF-8 bytes', () => {
    const result = fileUploadBodySchema.safeParse({
      path: '/tmp/file.txt',
      content: 'x'.repeat(AGENT_MAX_FILE_WRITE_BYTES),
      encoding: 'text',
    });
    expect(result.success).toBe(true);
  });

  it('rejects text content over 4MB of UTF-8 bytes', () => {
    const result = fileUploadBodySchema.safeParse({
      path: '/tmp/file.txt',
      content: 'x'.repeat(AGENT_MAX_FILE_WRITE_BYTES + 1),
      encoding: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('measures text content in UTF-8 bytes, not string length (multi-byte)', () => {
    // 'é' is 1 UTF-16 code unit but 2 UTF-8 bytes: 2.5M chars = 5MB > 4MB.
    const result = fileUploadBodySchema.safeParse({
      path: '/tmp/file.txt',
      content: 'é'.repeat(2_500_000),
      encoding: 'text',
    });
    expect(result.success).toBe(false);
  });

  it('applies the text-encoding byte check when encoding is omitted (defaults to text)', () => {
    const result = fileUploadBodySchema.safeParse({
      path: '/tmp/file.txt',
      content: 'é'.repeat(2_500_000),
    });
    expect(result.success).toBe(false);
  });
});
