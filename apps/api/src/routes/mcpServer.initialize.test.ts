import { describe, it, expect } from 'vitest';
import { buildInitializeResult } from './mcpServer';

describe('buildInitializeResult', () => {
  it('pins the protocol version', () => {
    expect(buildInitializeResult().protocolVersion).toBe('2024-11-05');
  });

  it('returns a non-empty instructions string', () => {
    const r = buildInitializeResult();
    expect(typeof r.instructions).toBe('string');
    expect(r.instructions.length).toBeGreaterThan(200);
  });
});
