import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../db', async (orig) => ({ ...(await orig<typeof import('../../../db')>()), closeDb: vi.fn().mockResolvedValue(undefined) }));

import { parseArgs, UsageError } from './tool-capture';

describe('tool-capture --raw-out', () => {
  it('accepts a path and exposes it', () => {
    expect(parseArgs(['--surface', 'chat', '--raw-out', 'x.raw.jsonl']).rawOut).toBe('x.raw.jsonl');
    expect(parseArgs(['--surface', 'chat']).rawOut).toBeUndefined();
  });
  it('is refused without a path', () => {
    expect(() => parseArgs(['--surface', 'chat', '--raw-out'])).toThrow(UsageError);
    expect(() => parseArgs(['--surface', 'chat', '--raw-out', '--turns', '2'])).toThrow(UsageError);
  });
});
