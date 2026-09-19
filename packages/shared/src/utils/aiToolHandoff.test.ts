import { describe, it, expect } from 'vitest';
import {
  AI_TOOL_APPROVED_EXECUTING,
  AI_TOOL_APPROVED_COMPLETED,
  AI_TOOL_APPROVED_FAILED,
  AI_TOOL_HANDOFF_STATUSES,
  aiToolHandoffIsError,
  isAiToolHandoffOutput,
} from './aiToolHandoff';

describe('aiToolHandoff wire contract (#6022)', () => {
  it('carries the three post-approval outcomes', () => {
    expect(AI_TOOL_HANDOFF_STATUSES).toEqual([
      AI_TOOL_APPROVED_EXECUTING,
      AI_TOOL_APPROVED_COMPLETED,
      AI_TOOL_APPROVED_FAILED,
    ]);
  });

  it('recognises every handoff status by shape, not by message text', () => {
    for (const status of AI_TOOL_HANDOFF_STATUSES) {
      expect(isAiToolHandoffOutput({ status, message: 'x' })).toBe(true);
    }
    expect(isAiToolHandoffOutput({ message: 'approved_executing' })).toBe(false);
    expect(isAiToolHandoffOutput({ status: 'something_else' })).toBe(false);
    expect(isAiToolHandoffOutput(null)).toBe(false);
  });

  it('only the failed outcome is an error — a terminal failure must never be published as isError:false', () => {
    expect(aiToolHandoffIsError(AI_TOOL_APPROVED_FAILED)).toBe(true);
    expect(aiToolHandoffIsError(AI_TOOL_APPROVED_EXECUTING)).toBe(false);
    expect(aiToolHandoffIsError(AI_TOOL_APPROVED_COMPLETED)).toBe(false);
  });
});
