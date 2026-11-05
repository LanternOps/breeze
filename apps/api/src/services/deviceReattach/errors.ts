/**
 * Typed refusals of the reattach intent service and the rebind routes
 * (#8318 spec §6.3, §6.4, §8 "Refusals"). One shape for every caller: the
 * wave 2 route maps `status` + `code` straight onto its response, and the
 * agent routes answer with `{ error, code, state?, cancelReason? }`.
 */
import type { DeviceReattachIntentState } from '../../db/schema';

export type ReattachRefusalStatus = 400 | 401 | 403 | 404 | 409 | 429 | 503;

export interface ReattachRefusal {
  ok: false;
  status: ReattachRefusalStatus;
  code: string;
  message: string;
  /** The intent's state, when the refusal is about an intent that exists. */
  state?: DeviceReattachIntentState;
  cancelReason?: string | null;
}

export function reattachRefusal(
  status: ReattachRefusalStatus,
  code: string,
  message: string,
  extra: Pick<ReattachRefusal, 'state' | 'cancelReason'> = {},
): ReattachRefusal {
  return { ok: false, status, code, message, ...extra };
}

/** Thrown inside a transaction to roll it back and surface a typed refusal. */
export class ReattachRefusedError extends Error {
  constructor(readonly refusal: ReattachRefusal) {
    super(refusal.message);
    this.name = 'ReattachRefusedError';
  }
}

/**
 * The refusal of an intent that has ended (or a confirm on a not-yet-staged
 * one). `code` is the state (`cancelled`, `expired`, `confirmed`,
 * `not_staged`); a cancelled intent carries its `cancelReason` beside it. The
 * call that CAUSES a cancellation answers with the reason as its code instead
 * (`restage_refused`, `target_alive`, …, see `cancelledRefusal`), so the
 * agent tells "my call ended it" from "it had already ended" — and either way
 * reads `state` to know the intent is over (§6.6).
 */
export function intentStateRefusal(
  state: DeviceReattachIntentState,
  cancelReason: string | null,
): ReattachRefusal {
  if (state === 'cancelled') {
    return reattachRefusal(409, 'cancelled', `The reattach intent was cancelled (${cancelReason ?? 'unknown'})`, {
      state,
      cancelReason,
    });
  }
  if (state === 'expired') {
    return reattachRefusal(409, 'expired', 'The reattach intent expired', { state, cancelReason: null });
  }
  if (state === 'confirmed') {
    return reattachRefusal(409, 'confirmed', 'The reattach intent is already confirmed', { state, cancelReason: null });
  }
  return reattachRefusal(409, 'not_staged', 'The reattach intent has not been staged', { state, cancelReason: null });
}

/** The refusal of the call that cancelled the intent: 409, the reason as the code, state `cancelled`. */
export function cancelledRefusal(reason: string): ReattachRefusal {
  return reattachRefusal(409, reason, `The reattach was refused and its intent cancelled (${reason})`, {
    state: 'cancelled',
    cancelReason: reason,
  });
}

/** The body an agent route answers a refusal with. */
export function refusalBody(refusal: ReattachRefusal): Record<string, unknown> {
  return {
    error: refusal.message,
    code: refusal.code,
    ...(refusal.state ? { state: refusal.state } : {}),
    ...(refusal.cancelReason !== undefined && refusal.state ? { cancelReason: refusal.cancelReason } : {}),
  };
}
