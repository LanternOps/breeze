/**
 * Parses the Go agent's untyped `http_check` result map into the typed TLS
 * observation persisted on `network_monitors` (#5751 W03, #5754).
 *
 * The agent emits `sslState` explicitly rather than letting the API infer it:
 * a TLS handshake failure returns before any certificate exists, so from the
 * server side the absence of `sslExpiry` cannot distinguish "plain HTTP" from
 * "the handshake failed" from "the check never ran". Inferring would guess,
 * and a guessed `observed` is a fabricated finding.
 *
 * Lives outside `monitorWorker.ts` (already ~900 lines) so the two decisions
 * that matter are testable without a database.
 */

/** Mirrors `network_monitors_tls_state_chk`. */
export const TLS_STATES = ['observed', 'handshake_failed', 'not_tls'] as const;
export type TlsState = (typeof TLS_STATES)[number];

/** Matches the `varchar(255)` width of `tls_issuer` / `tls_observed_host`. */
const MAX_TLS_TEXT = 255;

export interface TlsObservation {
  state: TlsState;
  /** The certificate's notAfter. Null unless the state is `observed`. */
  notAfter: Date | null;
  /** Issuer DN, display-only. Null unless the state is `observed`. */
  issuer: string | null;
  /**
   * The endpoint the certificate actually belongs to. Redirects are followed
   * by default, so a monitor on `a.example` can legitimately report
   * `b.example`'s certificate — a finding that omits this names the wrong
   * endpoint.
   */
  observedHost: string | null;
}

/** The subset of `network_monitors` columns an observation writes. */
export interface TlsObservationUpdate {
  tlsState?: TlsState | null;
  tlsObservedAt?: Date | null;
  tlsObservedHost?: string | null;
  tlsNotAfter?: Date | null;
  tlsIssuer?: string | null;
}

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > MAX_TLS_TEXT ? trimmed.slice(0, MAX_TLS_TEXT) : trimmed;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Returns `null` when the result carries no recognised `sslState` at all —
 * which is every `icmp_ping` / `dns_check` / `tcp_port` result, and every
 * result from an agent predating this wave. That null is load-bearing: the
 * caller must then leave the stored observation untouched rather than clearing
 * it, or one non-HTTP check would erase a good certificate reading.
 *
 * An unrecognised state value is also `null`, so a future or corrupted agent
 * value can never reach the CHECK and abort the whole result transaction.
 */
export function readTlsObservation(
  details: Record<string, unknown> | undefined | null,
): TlsObservation | null {
  if (!details) return null;
  const raw = details['sslState'];
  if (typeof raw !== 'string') return null;
  if (!(TLS_STATES as readonly string[]).includes(raw)) return null;
  const state = raw as TlsState;

  const observedHost = readText(details['sslObservedHost']);
  if (state !== 'observed') {
    return { state, notAfter: null, issuer: null, observedHost };
  }
  return {
    state,
    notAfter: readDate(details['sslExpiry']),
    issuer: readText(details['sslIssuer']),
    observedHost,
  };
}

/**
 * Builds the `network_monitors` update fragment for one check result.
 *
 * Empty when there is no observation, so the fragment can be spread into the
 * worker's existing `updateSet` unconditionally.
 *
 * A `handshake_failed` result deliberately DOES write: it clears
 * `tls_not_after` and records the state, which is the whole reason the state
 * column exists — a stale expiry left behind by a monitor that can no longer
 * complete a handshake would read as "fine".
 */
export function tlsObservationUpdate(
  details: Record<string, unknown> | undefined | null,
  observedAt: Date,
): TlsObservationUpdate {
  const tls = readTlsObservation(details);
  if (!tls) return {};

  // `network_monitors_tls_observed_shape_chk` requires an `observed` row to
  // carry a not-after and a host. An agent result missing either is degraded
  // to `handshake_failed` — "we could not read a usable certificate" — rather
  // than aborting the entire check-result transaction with a 23514.
  const complete = tls.state === 'observed' && tls.notAfter !== null && tls.observedHost !== null;
  const state: TlsState = tls.state === 'observed' && !complete ? 'handshake_failed' : tls.state;

  return {
    tlsState: state,
    tlsObservedAt: observedAt,
    tlsObservedHost: tls.observedHost,
    tlsNotAfter: complete ? tls.notAfter : null,
    tlsIssuer: complete ? tls.issuer : null,
  };
}
