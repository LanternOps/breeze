import { describe, expect, it } from 'vitest';
import { SDK_CHILD_HOST_CONTEXT_GUARDS } from './sdkChildEnvGuards';

describe('SDK_CHILD_HOST_CONTEXT_GUARDS', () => {
  it('keeps the host auto-memory and CLAUDE.md out of every child (#7444)', () => {
    expect(SDK_CHILD_HOST_CONTEXT_GUARDS.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(SDK_CHILD_HOST_CONTEXT_GUARDS.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
  });

  it("opts out of the CLI's thinking.display 'updates' default (Agent SDK 0.3.288)", () => {
    // Any other value (or none) lets the CLI rewrite every adaptive request to
    // display 'updates' + the thinking-display-updates beta, even when the
    // caller passed display 'omitted' explicitly.
    expect(SDK_CHILD_HOST_CONTEXT_GUARDS.CLAUDE_CODE_THINKING_DISPLAY_UPDATES).toBe('0');
  });
});
