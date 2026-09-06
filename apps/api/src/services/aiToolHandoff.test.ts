import { describe, expect, it } from 'vitest';
import {
  APPROVED_EXECUTING_MESSAGE,
  APPROVED_EXECUTING_STATUS,
  approvedExecutingDenial,
  buildToolHandoffResult,
  isToolHandoffResult,
} from './aiToolHandoff';

describe('aiToolHandoff', () => {
  it('pins the wire literal — clients switch on this exact string', () => {
    // Mobile (ToolIndicator) and web (AiToolCallCard) compare against this
    // literal. Changing it here without changing them there is a silent
    // regression back to "FAILED" in red, which is #5107 itself.
    expect(APPROVED_EXECUTING_STATUS).toBe('approved_executing');
  });

  it('tells the model it is approved, running, and reported separately', () => {
    // The model narrated a failure off the old error text. All three facts
    // have to be in the message or it will either apologise or retry.
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/approved/i);
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/not.*retried|do not retry/i);
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/reported separately/i);
    expect(APPROVED_EXECUTING_MESSAGE).not.toMatch(/\bfailed\b(?! )/i);
  });

  it('builds a payload whose status field is the discriminator', () => {
    expect(buildToolHandoffResult()).toEqual({
      status: 'approved_executing',
      message: APPROVED_EXECUTING_MESSAGE,
    });
  });

  it('pairs the marker with the message so a call site cannot get it wrong', () => {
    // The two fields are separate on PreToolUseCallback's denial variant;
    // pairing them in one constructor is what keeps a future third call site
    // from setting `handoff` alongside a real failure string (which would be
    // published with isError:false) or the reverse.
    expect(approvedExecutingDenial()).toEqual({
      allowed: false,
      error: APPROVED_EXECUTING_MESSAGE,
      handoff: APPROVED_EXECUTING_STATUS,
    });
  });

  it('recognises a handoff payload and nothing else', () => {
    expect(isToolHandoffResult(buildToolHandoffResult())).toBe(true);
    expect(isToolHandoffResult({ status: 'approved_executing' })).toBe(true);
    // An ordinary error result must never be mistaken for a handoff...
    expect(isToolHandoffResult({ error: 'Tool execution was rejected' })).toBe(false);
    // ...nor an ordinary success payload that happens to carry a status.
    expect(isToolHandoffResult({ status: 'completed' })).toBe(false);
    expect(isToolHandoffResult(null)).toBe(false);
    expect(isToolHandoffResult('approved_executing')).toBe(false);
  });
});
