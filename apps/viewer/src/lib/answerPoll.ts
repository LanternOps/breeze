/**
 * Answer-poll classification (SEC-038 W06, #5537).
 *
 * `GET /desktop-ws/:id/viewer/session` is polled until the agent's WebRTC
 * answer lands. A server-side End (operator End, teardown sweep, lease
 * revocation) commits its terminal decision BEFORE the agent acknowledges the
 * `stop_desktop`, leaving the row terminal with `terminationPhase = 'pending'`
 * — and, on a reconnect attempt, possibly still carrying the previous
 * attempt's answer. That answer must never be used: the session is ended the
 * moment the server decided, whether or not the endpoint has caught up.
 *
 * Kept pure so the ordering rules are unit-testable without a fetch loop.
 */

export type AnswerPollSession = {
  status?: string | null;
  /** Absent on a pre-W06 server; treated as 'none'. */
  terminationPhase?: 'none' | 'pending' | 'confirmed' | string | null;
  webrtcAnswer?: string | null;
  errorMessage?: string | null;
};

export type AnswerPollVerdict =
  | { kind: 'answer'; answer: string }
  | { kind: 'wait' }
  | { kind: 'failed'; message: string | null }
  | { kind: 'ended' };

/** Statuses that mean the session can never produce a usable answer. */
const ENDED_STATUSES = new Set(['disconnected', 'denied']);

export function classifyAnswerPoll(data: AnswerPollSession): AnswerPollVerdict {
  // A terminal failure takes precedence over an answer from an earlier
  // attempt on this session — the viewer surfaces the agent's reason.
  if (data.status === 'failed') {
    return {
      kind: 'failed',
      message: typeof data.errorMessage === 'string' && data.errorMessage.length > 0
        ? data.errorMessage
        : null,
    };
  }
  // The phase is authoritative: 'pending' means the server has already
  // decided this session is over and is only waiting on the endpoint's
  // acknowledgement. Never reconnect using stale signaling data.
  const phase = data.terminationPhase ?? 'none';
  if (phase === 'pending' || phase === 'confirmed') {
    return { kind: 'ended' };
  }
  if (data.status && ENDED_STATUSES.has(data.status)) {
    return { kind: 'ended' };
  }
  if (typeof data.webrtcAnswer === 'string' && data.webrtcAnswer.length > 0) {
    return { kind: 'answer', answer: data.webrtcAnswer };
  }
  return { kind: 'wait' };
}
