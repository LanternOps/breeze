import { describe, expect, it } from 'vitest';
import {
  APPROVED_COMPLETED_MESSAGE,
  APPROVED_COMPLETED_STATUS,
  APPROVED_EXECUTING_MESSAGE,
  APPROVED_EXECUTING_STATUS,
  APPROVED_FAILED_STATUS,
  approvedExecutingDenial,
  buildToolHandoffResult,
  describeIntentOutcome,
  handoffDenialForOutcome,
  isTerminalIntentStatus,
  isToolHandoffResult,
} from './aiToolHandoff';

describe('aiToolHandoff', () => {
  it('pins the wire literal — clients switch on this exact string', () => {
    // Mobile (ToolIndicator) and web (AiToolCallCard) compare against this
    // literal. Changing it here without changing them there is a silent
    // regression back to "FAILED" in red, which is #5107 itself.
    expect(APPROVED_EXECUTING_STATUS).toBe('approved_executing');
  });

  it('tells the model it is approved, running, and NOT yet known to have worked', () => {
    // The model narrated a failure off the old error text, so the message has
    // to say approved + do-not-retry. #6022 adds the third fact: the old
    // wording promised the outcome was "reported separately" when nothing
    // reported it, and never forbade claiming success — which is exactly how
    // the operator was told a refused autoInstall arm had succeeded.
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/approved/i);
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/not.*retried|do not retry/i);
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/not.*confirmed/i);
    expect(APPROVED_EXECUTING_MESSAGE).toMatch(/not claim.*succe/i);
    expect(APPROVED_EXECUTING_MESSAGE).not.toMatch(/reported separately/i);
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

  describe('describeIntentOutcome — intent terminal result -> chat message (#6022)', () => {
    it('classifies which intent statuses are terminal', () => {
      for (const status of ['completed', 'failed', 'rejected', 'expired', 'cancelled']) {
        expect(isTerminalIntentStatus(status)).toBe(true);
      }
      for (const status of ['pending_approval', 'approved', 'executing']) {
        expect(isTerminalIntentStatus(status)).toBe(false);
      }
    });

    it('a tool_returned_error intent becomes a FAILED outcome carrying the refusal verbatim (the #6022 repro)', () => {
      const guardrail =
        'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.';
      const outcome = describeIntentOutcome({
        status: 'failed',
        errorCode: 'tool_returned_error',
        result: { error: guardrail },
      });

      expect(outcome.handoff).toBe(APPROVED_FAILED_STATUS);
      expect(outcome.message).toContain(guardrail);
      expect(outcome.message).toMatch(/did not|failed/i);
      // The exact lie this issue is about: the model must be told not to
      // report success.
      expect(outcome.message).toMatch(/not claim.*succe/i);
    });

    it('falls back to the error code, then the status, when the result carries no error string', () => {
      expect(describeIntentOutcome({ status: 'failed', errorCode: 'content_changed', result: null }).message).toContain(
        'content_changed',
      );
      expect(describeIntentOutcome({ status: 'failed', errorCode: null, result: {} }).message).toMatch(/failed/i);
    });

    it('maps rejected / expired / cancelled to a failure that says it never ran', () => {
      for (const status of ['rejected', 'expired', 'cancelled']) {
        const outcome = describeIntentOutcome({ status, errorCode: null, result: null });
        expect(outcome.handoff).toBe(APPROVED_FAILED_STATUS);
        expect(outcome.message).toMatch(/did not run|never ran|not take effect/i);
      }
    });

    it('maps completed to a non-error completion that does not invent result detail', () => {
      const outcome = describeIntentOutcome({
        status: 'completed',
        errorCode: null,
        result: { secretThatMustNotLeak: 'hunter2' },
      });
      expect(outcome.handoff).toBe(APPROVED_COMPLETED_STATUS);
      expect(outcome.message).toBe(APPROVED_COMPLETED_MESSAGE);
      expect(outcome.message).not.toContain('hunter2');
    });

    it('a non-terminal or unreadable intent stays "executing" — a failed READ is not evidence of a failed ACTION', () => {
      expect(describeIntentOutcome({ status: 'executing', errorCode: null, result: null }).handoff).toBe(
        APPROVED_EXECUTING_STATUS,
      );
      expect(describeIntentOutcome(null).handoff).toBe(APPROVED_EXECUTING_STATUS);
      expect(describeIntentOutcome(null).message).toBe(APPROVED_EXECUTING_MESSAGE);
    });

    it('truncates a runaway error string so it cannot blow the tool-result budget', () => {
      const outcome = describeIntentOutcome({
        status: 'failed',
        errorCode: 'tool_returned_error',
        result: { error: 'x'.repeat(5000) },
      });
      expect(outcome.message.length).toBeLessThan(1200);
      expect(outcome.message).toContain('…');
    });

    it('pairs each outcome with the right denial marker so isError cannot be derived wrongly', () => {
      const failed = handoffDenialForOutcome(
        describeIntentOutcome({ status: 'failed', errorCode: 'tool_returned_error', result: { error: 'nope' } }),
      );
      expect(failed).toEqual({
        allowed: false,
        error: expect.stringContaining('nope'),
        handoff: APPROVED_FAILED_STATUS,
      });

      const stillRunning = handoffDenialForOutcome(describeIntentOutcome(null));
      expect(stillRunning).toEqual(approvedExecutingDenial());
    });
  });
});
