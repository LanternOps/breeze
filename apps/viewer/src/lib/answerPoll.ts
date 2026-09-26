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
  /**
   * #6818: the end-user prompt mode the API shipped with this start
   * ('consent' | 'notify' | 'off'). Absent on an older API.
   */
  promptMode?: string | null;
  /**
   * #6818: how long the API expects the agent may take to answer this start,
   * covering the consent dialog and an on-demand helper spawn. Absent on an
   * older API, in which case the viewer keeps its default.
   */
  answerTimeoutMs?: number | null;
};

export type AnswerPollVerdict =
  | { kind: 'answer'; answer: string }
  | { kind: 'wait' }
  | { kind: 'failed'; message: string | null }
  | { kind: 'denied'; message: string }
  | { kind: 'ended' };

/**
 * Shown when the agent's consent gate refused the start but the API recorded
 * no reason (an API older than #6818 never writes one).
 */
export const CONSENT_DENIED_DEFAULT_MESSAGE =
  'The remote session was not approved on the device.';

/**
 * Upper bound on any server-provided answer budget. The API's consent budget is
 * well under this (#6818); the cap only stops a bad value from leaving the
 * viewer spinning indefinitely.
 */
export const MAX_ANSWER_TIMEOUT_MS = 180_000;

/**
 * The answer-poll deadline to use given the latest poll response: the
 * server's budget when it sent a sane one, never shorter than `defaultMs`
 * and never longer than MAX_ANSWER_TIMEOUT_MS.
 */
export function resolveAnswerTimeoutMs(data: AnswerPollSession, defaultMs: number): number {
  const budget = data.answerTimeoutMs;
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget <= defaultMs) {
    return defaultMs;
  }
  return Math.min(budget, MAX_ANSWER_TIMEOUT_MS);
}

/** Statuses that mean the session can never produce a usable answer. */
const ENDED_STATUSES = new Set(['disconnected']);

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
  // #6818: the agent's consent gate refused the start (the end user declined,
  // did not answer in time, or nobody could be asked under a "block" policy).
  // The API commits that as status 'denied' with phase 'confirmed', so this
  // must run before the phase check or the reason is lost to a generic
  // "session ended".
  if (data.status === 'denied') {
    return {
      kind: 'denied',
      message: typeof data.errorMessage === 'string' && data.errorMessage.length > 0
        ? data.errorMessage
        : CONSENT_DENIED_DEFAULT_MESSAGE,
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
