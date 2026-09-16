import { describe, expect, it } from 'vitest';
import { classifyAnswerPoll } from './answerPoll';

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
    expect(classifyAnswerPoll({ status: 'denied', webrtcAnswer: null }))
      .toEqual({ kind: 'ended' });
  });
});
