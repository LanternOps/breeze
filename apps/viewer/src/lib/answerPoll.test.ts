import { describe, expect, it } from 'vitest';
import {
  classifyAnswerPoll,
  CONSENT_DENIED_DEFAULT_MESSAGE,
  MAX_ANSWER_TIMEOUT_MS,
  resolveAnswerTimeoutMs,
} from './answerPoll';

// SEC-038 W06 (#5537): a server-side End commits before the agent acknowledges
// the stop, leaving the session terminal with terminationPhase='pending'. The
// answer poll must treat that as ended — never as an answer to connect with.
describe('classifyAnswerPoll', () => {
  it('waits while the session is live and has no answer yet', () => {
    expect(classifyAnswerPoll({ status: 'pending', terminationPhase: 'none', webrtcAnswer: null }))
      .toEqual({ kind: 'wait' });
  });

  it('returns the answer for a live session', () => {
    expect(classifyAnswerPoll({ status: 'connecting', terminationPhase: 'none', webrtcAnswer: 'v=0' }))
      .toEqual({ kind: 'answer', answer: 'v=0' });
  });

  it('tolerates a pre-W06 server that omits terminationPhase', () => {
    expect(classifyAnswerPoll({ status: 'connecting', webrtcAnswer: 'v=0' }))
      .toEqual({ kind: 'answer', answer: 'v=0' });
  });

  it('reports a failed start as failed with the agent reason', () => {
    expect(classifyAnswerPoll({ status: 'failed', errorMessage: 'no display', webrtcAnswer: 'v=0 stale' }))
      .toEqual({ kind: 'failed', message: 'no display' });
  });

  it('treats a pending teardown as ended even when a stale answer is present', () => {
    expect(classifyAnswerPoll({ status: 'disconnected', terminationPhase: 'pending', webrtcAnswer: 'v=0 stale' }))
      .toEqual({ kind: 'ended' });
  });

  it('treats a pending teardown as ended even if the status still reads live', () => {
    // Defensive: the phase is the authoritative "server has decided" signal.
    expect(classifyAnswerPoll({ status: 'active', terminationPhase: 'pending', webrtcAnswer: 'v=0 stale' }))
      .toEqual({ kind: 'ended' });
  });

  it('treats a confirmed teardown as ended', () => {
    expect(classifyAnswerPoll({ status: 'disconnected', terminationPhase: 'confirmed', webrtcAnswer: null }))
      .toEqual({ kind: 'ended' });
  });

  it('treats a terminal status with no phase (legacy row) as ended', () => {
    expect(classifyAnswerPoll({ status: 'disconnected', webrtcAnswer: null }))
      .toEqual({ kind: 'ended' });
  });
});

// #6818: the agent finalizes a consent refusal as status 'denied' with
// terminationPhase 'confirmed'. The viewer must fail fast with the consent
// reason instead of the generic "session ended" text.
describe('classifyAnswerPoll — consent denial (#6818)', () => {
  it('surfaces the recorded consent reason, ahead of the confirmed phase', () => {
    expect(classifyAnswerPoll({
      status: 'denied',
      terminationPhase: 'confirmed',
      errorMessage: 'The end user declined the remote session.',
      webrtcAnswer: null,
    })).toEqual({ kind: 'denied', message: 'The end user declined the remote session.' });
  });

  it('falls back to a consent-specific message when no reason was recorded', () => {
    expect(classifyAnswerPoll({ status: 'denied', webrtcAnswer: null }))
      .toEqual({ kind: 'denied', message: CONSENT_DENIED_DEFAULT_MESSAGE });
  });
});

describe('resolveAnswerTimeoutMs (#6818)', () => {
  it('keeps the default when the server sends no budget (older API)', () => {
    expect(resolveAnswerTimeoutMs({ status: 'connecting' }, 15_000)).toBe(15_000);
  });

  it('extends to the server budget for a consent-mode session', () => {
    expect(resolveAnswerTimeoutMs({ answerTimeoutMs: 77_000 }, 15_000)).toBe(77_000);
  });

  it('never shortens below the default', () => {
    expect(resolveAnswerTimeoutMs({ answerTimeoutMs: 1_000 }, 15_000)).toBe(15_000);
  });

  it('caps an absurd budget so a broken agent cannot hang the viewer forever', () => {
    expect(resolveAnswerTimeoutMs({ answerTimeoutMs: 10_000_000 }, 15_000)).toBe(MAX_ANSWER_TIMEOUT_MS);
  });

  it.each([Number.NaN, -5, 'soon', null])('ignores a malformed budget (%s)', (value) => {
    expect(resolveAnswerTimeoutMs({ answerTimeoutMs: value as never }, 15_000)).toBe(15_000);
  });
});
