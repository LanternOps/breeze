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
 * The URL an `http_check` is actually dispatched against — `config.url` when
 * set, otherwise the monitor's `target` (mirrors `buildMonitorCommand`).
 * Both inputs change only via `PATCH /monitors/:id`, which is what makes this
 * a sound provenance key.
 */
export function monitorRequestUrl(monitor: { target: string; config: unknown }): string {
  const config = (monitor.config ?? {}) as Record<string, unknown>;
  const url = config['url'];
  // Trimmed, because the echoed side is trimmed too — an asymmetry here would
  // make the comparison below fail forever for a value that happens to carry
  // surrounding whitespace.
  const chosen = typeof url === 'string' && url.trim() !== '' ? url : monitor.target;
  return chosen.trim();
}

/**
 * Does the URL the agent says it requested still describe where this monitor
 * points?
 *
 * Not a plain `===`. The agent truncates its echo to 255 BYTES
 * (`truncateObservation`), so for a longer URL — an authenticated status
 * endpoint with a token or a long query string is an ordinary case, and
 * neither `config.url` nor `target` (varchar(500)) is capped anywhere near
 * 255 — the two sides are legitimately different strings. Comparing them raw
 * would drop EVERY observation for such a monitor forever, with no edit ever
 * having happened: a silent, permanent outage of the whole feature for that
 * endpoint.
 *
 * So a prefix is accepted, but ONLY when the echo sits at the truncation
 * boundary. Accepting any prefix would let a genuinely stale echo of
 * `https://a.example` pass for a monitor now pointing at `https://a.example/x`
 * — the exact misattribution this guard exists to stop.
 */
function requestUrlMatches(requested: string, expected: string): boolean {
  if (requested === expected) return true;
  // A rune-safe cut at 255 bytes can land up to 3 bytes short.
  const echoedBytes = Buffer.byteLength(requested, 'utf8');
  return echoedBytes >= MAX_TLS_TEXT - 3 && expected.startsWith(requested);
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
 *
 * `expectedRequestUrl` closes the other half of the staleness problem.
 * `PATCH /monitors/:id` clears the columns when the target or config changes,
 * but that does nothing about a check ALREADY in flight: its result lands
 * afterwards and would be attributed to the new endpoint. The agent echoes the
 * URL it actually requested, so a mismatched (or missing) echo means this
 * result describes an endpoint the monitor no longer points at, and the
 * observation is dropped rather than misattributed. The rest of the writeback
 * — status, response time, failure counter — still lands, because those are
 * about reachability at that moment and remain true.
 */
export function tlsObservationUpdate(
  details: Record<string, unknown> | undefined | null,
  observedAt: Date,
  options: {
    /** The monitor's CURRENT request URL, read under a row lock. */
    expectedRequestUrl?: string | null;
    /** For the log line only. */
    monitorId?: string;
  } = {},
): TlsObservationUpdate {
  const rawState = details?.['sslState'];
  const tls = readTlsObservation(details);
  if (!tls) {
    // A value we do not recognise is dropped rather than written, but silently
    // dropping it would leave no trace of a protocol drift between agent and
    // API. "No sslState key at all" is the ordinary non-HTTP case and is not
    // worth a line.
    if (typeof rawState === 'string' && rawState !== '') {
      console.warn(
        `[monitorTls] Ignoring unrecognised sslState ${JSON.stringify(rawState)} for monitor ${options.monitorId ?? 'unknown'}`,
      );
    }
    return {};
  }

  if (options.expectedRequestUrl !== undefined) {
    const requested = readText(details?.['sslRequestedUrl']);
    const expected = options.expectedRequestUrl;
    if (requested === null || expected === null || !requestUrlMatches(requested, expected)) {
      console.warn(
        `[monitorTls] Dropping TLS observation for monitor ${options.monitorId ?? 'unknown'}: `
        + `result was produced against ${requested === null ? 'an unrecorded URL' : JSON.stringify(requested)}, `
        + `but the monitor now points at ${JSON.stringify(options.expectedRequestUrl)}`,
      );
      return {};
    }
  }

  // `network_monitors_tls_observed_shape_chk` requires an `observed` row to
  // carry a not-after, an observed-at AND a host. `observedAt` is a required
  // parameter here so the third leg is always satisfied; an agent result
  // missing either of the other two is degraded to `handshake_failed` — "we
  // could not read a usable certificate" — rather than aborting the entire
  // check-result transaction with a 23514.
  const complete = tls.state === 'observed' && tls.notAfter !== null && tls.observedHost !== null;
  const state: TlsState = tls.state === 'observed' && !complete ? 'handshake_failed' : tls.state;
  if (state !== tls.state) {
    // A degraded row is byte-for-byte identical to a genuine handshake
    // failure, so without this an operator debugging "why does this say
    // handshake_failed when the cert is obviously fine" gets no breadcrumb.
    console.warn(
      `[monitorTls] Degrading an incomplete 'observed' result to handshake_failed for monitor `
      + `${options.monitorId ?? 'unknown'} (sslExpiry=${JSON.stringify(details?.['sslExpiry'])}, `
      + `sslObservedHost=${JSON.stringify(details?.['sslObservedHost'])})`,
    );
  }

  return {
    tlsState: state,
    tlsObservedAt: observedAt,
    tlsObservedHost: tls.observedHost,
    tlsNotAfter: complete ? tls.notAfter : null,
    tlsIssuer: complete ? tls.issuer : null,
  };
}
