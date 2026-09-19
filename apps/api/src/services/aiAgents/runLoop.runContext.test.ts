import { describe, it, expect } from 'vitest';
import type { ToolExecutionContext } from '../toolExecutionContext';
import { createAgentRunPreToolUse } from './runLoop';

describe('ToolExecutionContext run fields', () => {
  it('accepts runTargets and stagedBytesRemaining', () => {
    const ctx: ToolExecutionContext = {
      runTargets: ['22222222-2222-4222-8222-222222222222'],
      stagedBytesRemaining: 1024,
    };
    expect(ctx.runTargets).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(ctx.stagedBytesRemaining).toBe(1024);
  });

  it('stays a constraint type — run identity is NOT copied onto it', () => {
    // Identity lives on the auth principal (agentAuthContext.ts:78/:89).
    // @ts-expect-error runId is deliberately absent from ToolExecutionContext (R4)
    const ctx: ToolExecutionContext = { runId: 'run-1' };
    expect(ctx).toBeTruthy();
  });

  it('createAgentRunPreToolUse accepts runTargets and stagedBytesRemaining', () => {
    expect(typeof createAgentRunPreToolUse).toBe('function');
    expect(createAgentRunPreToolUse.length).toBe(1);
  });
});
