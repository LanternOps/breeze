import { describe, expect, it } from 'vitest';
import { bmrCompleteSchema } from './schemas';

// D14: a bare-metal recovery completion report was answering "Request body
// too large" for a payload carrying ~9,900 unbounded `warnings` strings (the
// agent-side helper is being fixed to cap that list at 51 entries, but the
// schema itself had no bound at all). These caps give the API-side contract a
// hard, well-defined ceiling regardless of what any given agent version sends.
describe('bmrCompleteSchema — completion report caps (D14)', () => {
  const baseResult = { status: 'completed' as const };

  it('rejects a warnings array over 200 entries', () => {
    const warnings = Array.from({ length: 201 }, (_, i) => `warning-${i}`);
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a warnings array of exactly 200 entries', () => {
    const warnings = Array.from({ length: 200 }, (_, i) => `warning-${i}`);
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a single warning string over 2000 characters', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings: ['x'.repeat(2001)] },
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a warning string of exactly 2000 characters', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, warnings: ['x'.repeat(2000)] },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an optional non-negative integer failedFiles', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, failedFiles: 42 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.failedFiles).toBe(42);
  });

  it('rejects a negative failedFiles', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, failedFiles: -1 },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer failedFiles', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult, failedFiles: 1.5 },
    });
    expect(parsed.success).toBe(false);
  });

  it('leaves failedFiles undefined when the agent omits it (legacy agent)', () => {
    const parsed = bmrCompleteSchema.safeParse({
      token: 'recovery-token-1',
      result: { ...baseResult },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.result.failedFiles).toBeUndefined();
  });
});
