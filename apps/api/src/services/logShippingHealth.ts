import { z } from 'zod';

/**
 * Log-shipping health (#8608 / #8607, originating issue #8406).
 *
 * The agent reports a bounded `logShipping` object in its heartbeat. This
 * module is the pure core: strict parsing, per-beat classification, the
 * transition-only persistence plan, and the read-time derived state. No DB, no
 * clock: `now` is always injected.
 *
 * Invariants (see the plan's Global Constraints):
 *  - Observational only. It never gates dispatch, auth, or any security call.
 *  - Absence means UNKNOWN, never healthy and never failing.
 *  - "Sustained" is measured on the server receive clock. Agent timestamps are
 *    display-only and are never compared.
 *  - A malformed object is `invalid`: it neither clears nor extends an episode
 *    and is never coerced into a healthy zero.
 */

export const LOG_SHIPPING_SUSTAINED_MS = 30 * 60_000;
/** 80% of the agent's 500-entry buffer; absolute, so no previous-beat state is needed. */
export const LOG_SHIPPING_QUEUE_FAILING_DEPTH = 400;
/** Column width of devices.log_shipping_last_error. */
export const LOG_SHIPPING_LAST_ERROR_MAX = 200;
/** Wire cap for lastError (the agent maps to a closed vocabulary; the API only enforces the length). */
const LOG_SHIPPING_WIRE_ERROR_MAX = 160;

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  lastAttemptAt: z.string().datetime({ offset: true }).optional(),
  lastSuccessAt: z.string().datetime({ offset: true }).optional(),
  lastAttemptOk: z.boolean().optional(),
  lastError: z.string().max(LOG_SHIPPING_WIRE_ERROR_MAX).optional(),
  queueDepth: z.number().int().min(0).max(1_000_000),
  droppedLogs: z.number().int().min(0).max(1_000_000_000),
});

export type LogShippingReport = z.infer<typeof reportSchema>;
export type LogShippingStoredState = 'ok' | 'quiet' | 'failing';
export type ParsedLogShipping =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'ok'; report: LogShippingReport };

/**
 * `undefined` -> absent. Anything else is strict-parsed; a failure is
 * `invalid` (zod's object schema strips unknown keys).
 */
export function parseLogShipping(raw: unknown): ParsedLogShipping {
  if (raw === undefined) return { kind: 'absent' };
  const parsed = reportSchema.safeParse(raw);
  return parsed.success ? { kind: 'ok', report: parsed.data } : { kind: 'invalid' };
}

/**
 * Failing beat: the last COMPLETED attempt failed, OR logs were dropped since
 * the last good beat, OR the queue is nearly full. Else `quiet` when the agent
 * has no completed attempt to report, otherwise `ok`. Timestamps are never
 * compared (an explicit boolean outcome is immune to equal-second ordering).
 */
export function classifyLogShippingBeat(r: LogShippingReport): LogShippingStoredState {
  if (r.lastAttemptOk === false) return 'failing';
  if (r.droppedLogs > 0) return 'failing';
  if (r.queueDepth >= LOG_SHIPPING_QUEUE_FAILING_DEPTH) return 'failing';
  return r.lastAttemptOk === undefined ? 'quiet' : 'ok';
}

export interface LogShippingDeviceFields {
  logShippingState: string | null;
  logShippingFailureStartedAt: Date | null;
  logShippingLastError: string | null;
  status: string;
}

export type LogShippingWrite = Partial<{
  logShippingState: string | null;
  logShippingFailureStartedAt: Date | null;
  logShippingLastError: string | null;
}>;

/**
 * Transition-only persistence plan, compared against the device row the beat
 * already loaded. Returns `{}` whenever nothing changes, so steady-state beats
 * add zero keys (and therefore zero statements) to the beat's single
 * `UPDATE devices`.
 */
export function planLogShippingWrite(
  device: LogShippingDeviceFields,
  parsed: ParsedLogShipping,
  now: Date,
): LogShippingWrite {
  // A malformed report is neither evidence of health nor of failure.
  if (parsed.kind === 'invalid') return {};

  if (parsed.kind === 'absent') {
    // Downgrade / shipper disabled: stored state must not freeze at `failing`.
    if (
      device.logShippingState === null &&
      device.logShippingFailureStartedAt === null &&
      device.logShippingLastError === null
    ) {
      return {};
    }
    return { logShippingState: null, logShippingFailureStartedAt: null, logShippingLastError: null };
  }

  const state = classifyLogShippingBeat(parsed.report);
  const error =
    state === 'failing' && parsed.report.lastError
      ? parsed.report.lastError.slice(0, LOG_SHIPPING_LAST_ERROR_MAX)
      : null;

  const write: LogShippingWrite = {};
  const wasFailing = device.logShippingState === 'failing';

  if (device.logShippingState !== state) write.logShippingState = state;

  if (state === 'failing') {
    // Episode start is stamped once, on entry (or if a row somehow lost it).
    if (!wasFailing || device.logShippingFailureStartedAt === null) {
      write.logShippingFailureStartedAt = now;
    }
    if (!wasFailing || device.logShippingLastError !== error) write.logShippingLastError = error;
  } else {
    if (device.logShippingFailureStartedAt !== null) write.logShippingFailureStartedAt = null;
    if (device.logShippingLastError !== null) write.logShippingLastError = null;
  }
  return write;
}

export type DerivedLogShippingState = 'unknown' | 'healthy' | 'quiet' | 'failing';
export interface DerivedLogShipping {
  state: DerivedLogShippingState;
  failingSince: string | null;
  lastError: string | null;
}

const UNKNOWN: DerivedLogShipping = { state: 'unknown', failingSince: null, lastError: null };

/**
 * Read-time view. Never stored. `failing` requires the device to be online and
 * the episode to have lasted at least LOG_SHIPPING_SUSTAINED_MS on the server
 * clock; `lastError` is exposed only in that state.
 */
export function deriveLogShipping(
  row: Pick<LogShippingDeviceFields, 'status' | 'logShippingState' | 'logShippingFailureStartedAt' | 'logShippingLastError'>,
  now: Date,
): DerivedLogShipping {
  switch (row.logShippingState) {
    case 'ok':
      return { state: 'healthy', failingSince: null, lastError: null };
    case 'quiet':
      return { state: 'quiet', failingSince: null, lastError: null };
    case 'failing': {
      // Never report a shipping failure for a device that is not online.
      if (row.status !== 'online') return UNKNOWN;
      const started = row.logShippingFailureStartedAt;
      if (!started || now.getTime() - started.getTime() < LOG_SHIPPING_SUSTAINED_MS) {
        return { state: 'healthy', failingSince: null, lastError: null };
      }
      return {
        state: 'failing',
        failingSince: started.toISOString(),
        lastError: row.logShippingLastError,
      };
    }
    default:
      return UNKNOWN;
  }
}
