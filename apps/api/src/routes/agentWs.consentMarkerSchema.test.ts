import { describe, it, expect } from 'vitest';
import { desktopCommandResultSchema } from './agentWs';

// The desk-start `result` is `.strict()`: a field the agent sends that the
// schema does not declare drops the whole result as malformed, which leaves the
// session stuck in `connecting` until the viewer gives up. Version 2 agents
// (consentPromptProtocolVersion 2) report whether the consent prompt was shown
// and answered, and whether anyone is signed in to the captured session. These
// parse the schema directly, mirroring agentWs.terminalResultSchema.test.ts.
describe('desktopCommandResultSchema accepts version 2 consent markers', () => {
  const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const envelope = (result: Record<string, unknown>) => ({
    type: 'command_result' as const,
    commandId: `desk-start-${SESSION}`,
    status: 'completed' as const,
    result,
  });
  const ok = (result: Record<string, unknown>) => {
    const parsed = desktopCommandResultSchema.safeParse(envelope(result));
    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  };
  const rejected = (result: Record<string, unknown>) => {
    expect(desktopCommandResultSchema.safeParse(envelope(result)).success).toBe(false);
  };

  // Exactly the payloads agent/internal/heartbeat/consent_gate.go builds.
  it('accepts a version 2 user grant', () => {
    ok({
      sessionId: SESSION,
      answer: 'v=0',
      consentReason: 'user',
      consentOutcome: 'granted',
      consentProtocol: 2,
    });
  });

  it('accepts a start that proceeded because nobody is signed in', () => {
    ok({
      sessionId: SESSION,
      answer: 'v=0',
      consentReason: 'no_user_session',
      consentOutcome: 'unavailable',
      consentOccupancy: 'unoccupied',
      consentProtocol: 2,
    });
  });

  it('accepts a start that proceeded after a shown prompt went unanswered', () => {
    ok({
      sessionId: SESSION,
      answer: 'v=0',
      consentReason: 'timeout',
      consentOutcome: 'presented_expired',
      consentProtocol: 2,
    });
  });

  it.each([
    ['no_user_session', 'unavailable', 'unoccupied'],
    ['helper_unreachable', 'unavailable', 'occupied'],
    ['helper_unreachable', 'unavailable', 'unknown'],
    ['no_user', 'unknown', undefined],
    ['user', 'denied', undefined],
    ['timeout', 'presented_expired', undefined],
  ])('accepts a consent_denied with reason %s / outcome %s', (reason, outcome, occupancy) => {
    ok({
      event: 'consent_denied',
      sessionId: SESSION,
      reason,
      consentOutcome: outcome,
      ...(occupancy ? { consentOccupancy: occupancy } : {}),
      consentDetail: 'prompt_in_progress',
      consentProtocol: 2,
    });
  });

  it('still accepts a version 1 marker with none of the new fields', () => {
    ok({ sessionId: SESSION, answer: 'v=0', consentReason: 'helper_absent' });
    ok({ event: 'consent_denied', sessionId: SESSION, reason: 'helper_absent' });
  });

  // A signed-in user who could not be prompted is never a reason to start.
  it('rejects helper_unreachable as a reason a start proceeded', () => {
    rejected({ sessionId: SESSION, answer: 'v=0', consentReason: 'helper_unreachable', consentProtocol: 2 });
  });

  it('rejects values outside the declared sets', () => {
    rejected({ event: 'consent_denied', sessionId: SESSION, reason: 'user', consentOutcome: 'maybe' });
    rejected({ event: 'consent_denied', sessionId: SESSION, reason: 'user', consentOccupancy: 'someone' });
    rejected({ event: 'consent_denied', sessionId: SESSION, reason: 'user', consentProtocol: 3 });
    rejected({ event: 'consent_denied', sessionId: SESSION, reason: 'user', consentDetail: 'Has Spaces' });
    rejected({ event: 'consent_denied', sessionId: SESSION, reason: 'user', consentDetail: 'x'.repeat(65) });
  });

  it('still rejects an undeclared key, so .strict() is intact', () => {
    rejected({ sessionId: SESSION, answer: 'v=0', somethingNobodyDeclared: 1 });
  });
});
