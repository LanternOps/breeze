/**
 * Viewer-side revocation-lease renewal.
 *
 * A live desktop session is peer-to-peer: once the answer arrives, video and
 * input flow straight between this viewer and the agent, and the API server is
 * out of the loop. The lease is what puts it back in: every 25s the viewer asks
 * the server to re-verify that the operator is still authorized for this
 * session, and a definitive "no" tears the peer connection down here as well as
 * agent-side.
 *
 * Failure semantics mirror the API's: only a definitive negative (403/410) ends
 * the session. A network blip or a 503 `lease_unavailable` is tolerated for the
 * 90s grace window; past it — with at least two consecutive failures, so a
 * single unlucky request can never end a session — the connection is treated as
 * lost.
 */

/** How often to renew. Mirrors the API's REVOCATION_LEASE_RENEW_EVERY_MS. */
export const LEASE_RENEW_EVERY_MS = 25_000;
/** Outage budget before a session with no successful renew is given up on. */
export const LEASE_GRACE_MS = 90_000;
/**
 * A single failed request never ends a session — a transient blip is exactly
 * what the grace window exists for, and one dropped request is not evidence of
 * a lost control plane.
 */
export const LEASE_MIN_CONSECUTIVE_FAILURES = 2;

export type LeaseRenewOutcome =
  | { kind: 'renewed'; expiresAt?: number; hardDeadline?: number }
  | { kind: 'revoked'; reason: string }
  | { kind: 'unavailable' };

export const LEASE_REVOKED_MESSAGE = 'Session ended: access revoked.';
export const LEASE_LOST_MESSAGE = 'Session ended: connection lost.';

/**
 * Map an HTTP status to a lease outcome.
 *
 * 403 is the server's "revoked" answer and 410 covers a session that is gone
 * outright. Everything else — 503 `lease_unavailable`, a 5xx, a 429 — is
 * inconclusive and rides the grace window. A 401 is deliberately inconclusive
 * too: the viewer token has its own expiry/refresh handling, and treating it as
 * a revocation here would report the wrong cause.
 */
export function leaseOutcomeForStatus(status: number, reason?: string): LeaseRenewOutcome {
  if (status === 403 || status === 410) {
    return { kind: 'revoked', reason: reason ?? 'revoked' };
  }
  if (status >= 200 && status < 300) {
    return { kind: 'renewed' };
  }
  return { kind: 'unavailable' };
}

export interface RevocationLeaseParams {
  apiUrl: string;
  sessionId: string;
  accessToken: string;
}

function leaseRenewUrl(apiUrl: string, sessionId: string): string {
  const base = apiUrl.endsWith('/') ? apiUrl.slice(0, -1) : apiUrl;
  return `${base}/api/v1/desktop-ws/${encodeURIComponent(sessionId)}/viewer/lease/renew`;
}

/** One renewal round trip. Never throws: a network error is `unavailable`. */
export async function renewRevocationLeaseOnce(
  params: RevocationLeaseParams,
  fetchFn: typeof fetch = fetch,
): Promise<LeaseRenewOutcome> {
  let response: Response;
  try {
    response = await fetchFn(leaseRenewUrl(params.apiUrl, params.sessionId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.accessToken}`,
      },
    });
  } catch {
    return { kind: 'unavailable' };
  }

  type LeaseBody = { reason?: string; expiresAt?: number; hardDeadline?: number };
  let body: LeaseBody | null = null;
  try {
    body = (await response.json()) as LeaseBody;
  } catch {
    // A body-less answer is fine; the status carries the verdict.
  }

  const outcome = leaseOutcomeForStatus(response.status, body?.reason);
  if (outcome.kind === 'renewed' && body) {
    return { kind: 'renewed', expiresAt: body.expiresAt, hardDeadline: body.hardDeadline };
  }
  return outcome;
}

export interface RevocationLeaseCallbacks {
  /** The server withdrew authorization. Close the peer connection now. */
  onRevoked: (reason: string) => void;
  /** The grace window lapsed with no successful renewal. */
  onLost: () => void;
}

export interface RevocationLeaseDeps {
  fetchFn?: typeof fetch;
  now?: () => number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  renewEveryMs?: number;
  graceMs?: number;
}

/**
 * Start renewing the lease for a live session. Returns a stop function that is
 * safe to call more than once; after a terminal outcome the loop stops itself,
 * so a callback can never fire twice.
 */
export function startRevocationLeaseRenewal(
  params: RevocationLeaseParams,
  callbacks: RevocationLeaseCallbacks,
  deps: RevocationLeaseDeps = {},
): () => void {
  const now = deps.now ?? Date.now;
  const setIntervalFn = deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h as never));
  const renewEveryMs = deps.renewEveryMs ?? LEASE_RENEW_EVERY_MS;
  const graceMs = deps.graceMs ?? LEASE_GRACE_MS;

  let stopped = false;
  let consecutiveFailures = 0;
  let firstFailureAt: number | null = null;
  let handle: unknown;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (handle !== undefined) clearIntervalFn(handle);
  };

  const tick = async () => {
    if (stopped) return;
    const outcome = await renewRevocationLeaseOnce(params, deps.fetchFn);
    if (stopped) return;

    if (outcome.kind === 'revoked') {
      stop();
      callbacks.onRevoked(outcome.reason);
      return;
    }
    if (outcome.kind === 'renewed') {
      consecutiveFailures = 0;
      firstFailureAt = null;
      return;
    }

    consecutiveFailures += 1;
    const at = now();
    if (firstFailureAt === null) firstFailureAt = at;
    if (
      consecutiveFailures >= LEASE_MIN_CONSECUTIVE_FAILURES
      && at - firstFailureAt >= graceMs
    ) {
      stop();
      callbacks.onLost();
    }
  };

  handle = setIntervalFn(() => {
    void tick();
  }, renewEveryMs);
  return stop;
}
