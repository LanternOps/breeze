package bmr

import (
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"time"
)

// Recovery download session handling (#5635).
//
// The recovery download route serves objects only until the descriptor's
// expiresAt (authenticated_at + 1 h, capped by the token's own expiry) and
// answers 401 after that. /bmr/recover/authenticate re-opens the window
// (#5634) but is rate-limited per token: 3 first sign-ins an hour, and (since
// #12566) 3 renewals an hour for a client that sends the session renewal
// credential a previous sign-in returned (sessionRenewal), counted apart from
// other sign-ins with the same token such as a browser Preview. The client used
// to re-authenticate reactively, once per failed file, with no cap or
// backoff: the W04b KIT proof (recovery 61f8f8d5) turned one expiry into 3
// successful authenticates, ~300 × 429 and tens of thousands of per-file
// "authenticate failed: Too many requests" warnings.
//
// The session is now handled once per provider, not once per file:
//
//   - Proactive: from sessionRefreshLead before expiresAt, a download
//     refreshes the session (never blocking; downloads keep using the
//     still-valid descriptor if it fails). A refused attempt is retried after
//     the server's Retry-After (at least proactiveRetryInterval, jittered),
//     up to proactiveMaxAttempts per expiresAt value, so one refusal does not
//     cost the session (#12566). Never within proactiveRefreshMinInterval of
//     the last successful authenticate on the local monotonic clock —
//     recovery media often boots with an unset RTC, so a server expiresAt can
//     look permanently imminent.
//   - Reactive: a 401 triggers one single-flight refresh (a generation
//     counter lets concurrent 401s share it), backing off between attempts:
//     the server's Retry-After when sent (clamped to 5 minutes by
//     httputil.ParseRetryAfter, the agent-wide policy), else exponential
//     from reauthInitialDelay to reauthMaxDelay. A 429 is waited out, with
//     jitter, for up to reauthRateLimitedBudget in total and at most
//     reauthMaxRateLimitedAttempts calls (#12566: it used to give up after
//     three quick 429s).
//   - Run-level failure: a rate limit outlasting that budget, a rejected
//     token, exhausted transient retries, or a fresh session that
//     still answers 401 mark the session lost. Every later Download returns
//     ErrRecoverySessionLost immediately, and restoreFiles aborts the run on
//     it instead of logging one warning per remaining file, keeping what was
//     already restored and saying how to finish (a new recovery token).
//
// Server allowance (3 renewals per rolling hour, refused renewals not
// counted): a normal run renews once per session, about every 45 minutes
// (sessionRefreshLead before a one-hour expiry), so at most 2 renewals fall
// in any hour and one refused attempt (or two) still fits.
const (
	// sessionRefreshLead is how long before expiresAt the proactive
	// refresh starts: long enough for proactiveMaxAttempts tries spaced by
	// a clamped (5 minute) Retry-After before the session closes.
	sessionRefreshLead = 15 * time.Minute
	// proactiveRefreshMinInterval bounds successful proactive refreshes to
	// 2/h whatever the clocks say, inside the server's 3/h renewal limit.
	proactiveRefreshMinInterval = 30 * time.Minute
	// proactiveMaxAttempts caps proactive refresh attempts per expiresAt;
	// proactiveRetryInterval is the least time between two of them.
	proactiveMaxAttempts   = 3
	proactiveRetryInterval = 2 * time.Minute

	reauthInitialDelay = 15 * time.Second
	reauthMaxDelay     = 60 * time.Second
	// reauthMaxAttempts caps the non-429 authenticate calls per reactive
	// refresh. 429s are bounded separately: at most
	// reauthMaxRateLimitedAttempts calls and reauthRateLimitedBudget of
	// waiting in total (each wait is the server's Retry-After, clamped to
	// 5 minutes, plus up to 20% jitter).
	reauthMaxAttempts            = 5
	reauthMaxRateLimitedAttempts = 6
	reauthRateLimitedBudget      = 20 * time.Minute
)

// sessionRetryJitter spreads a retry wait over [d, 1.2d], so helpers that
// were refused together do not retry in lockstep. A var for tests.
var sessionRetryJitter = func(d time.Duration) time.Duration {
	if d <= 0 {
		return d
	}
	return d + time.Duration(rand.Int64N(int64(d/5)+1))
}

// recoverySessionLostResumeHint is appended to the abort message when the
// download session is lost: restored files are kept (nothing removes them),
// and a recovery token is spent by the run, so finishing needs a new one.
const recoverySessionLostResumeHint = "files restored so far stay in place; to restore the rest, create a new recovery token in Breeze and run the restore again (it restores every file in the snapshot again)"

// setSessionRenewal installs the session renewal credential a bootstrap
// carried (#12566); "" leaves renewals sent without one.
func (p *recoveryDownloadProvider) setSessionRenewal(credential string) {
	p.sessionMu.Lock()
	defer p.sessionMu.Unlock()
	p.sessionRenewal = credential
}

func (p *recoveryDownloadProvider) currentSessionRenewal() string {
	p.sessionMu.Lock()
	defer p.sessionMu.Unlock()
	return p.sessionRenewal
}

// ErrRecoverySessionLost marks a run-level failure of the recovery download
// session: the helper could not keep or re-establish it, so every remaining
// download would fail the same way. Callers abort the run on it
// (errors.Is) rather than recording a per-file failure.
var ErrRecoverySessionLost = errors.New("bmr: recovery download session lost")

var errRefreshMissingDescriptor = errors.New("bmr: refreshed bootstrap missing download descriptor")

func (p *recoveryDownloadProvider) sessionLost() error {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.lostErr
}

func (p *recoveryDownloadProvider) sessionGeneration() uint64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.generation
}

// markSessionLost records cause as the run-level session failure (first one
// wins) and returns the recorded error.
func (p *recoveryDownloadProvider) markSessionLost(cause error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lostErr == nil {
		p.lostErr = fmt.Errorf("%w: %w", ErrRecoverySessionLost, cause)
		slog.Error("bmr: recovery download session lost; remaining downloads will fail", "error", cause.Error())
	}
	return p.lostErr
}

// descriptorExpiry parses the current descriptor's expiresAt. ok is false
// when the server sent none (or an unparseable one) — no proactive refresh
// is possible then and the reactive path is the only one.
func (p *recoveryDownloadProvider) descriptorExpiry() (expiresAt time.Time, ok bool) {
	p.mu.RLock()
	raw := ""
	if p.descriptor != nil {
		raw = p.descriptor.ExpiresAt
	}
	p.mu.RUnlock()
	if raw == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// authenticateAndSwap performs one authenticate and, on success, installs
// the refreshed descriptor as a new generation. Caller holds sessionMu.
func (p *recoveryDownloadProvider) authenticateAndSwap() error {
	bootstrap, err := authenticateRecoverySessionRenewal(p.ctx, p.serverURL, p.token, p.sessionRenewal)
	if err != nil {
		return err
	}
	if bootstrap.SessionRenewal != "" {
		p.sessionRenewal = bootstrap.SessionRenewal
	}
	if bootstrap.Download == nil {
		return errRefreshMissingDescriptor
	}
	descriptor := rewriteDescriptorOrigin(p.serverURL, bootstrap.Download)

	// --- inserted (Task 9): compute the fresh capability and refuse the
	// swap outright if it drops a capability the provider already relies
	// on — keep the previous descriptor and generation, never shrink or
	// drop the admissible set.
	newMembership := descriptor != nil && HasCapability(descriptor.Capabilities, CapabilitySnapshotFileMembershipV1)

	p.mu.Lock()
	if p.membership && !newMembership {
		p.mu.Unlock()
		return ErrCapabilityDowngrade
	}
	p.descriptor = descriptor
	p.generation++
	p.membership = newMembership // inserted (Task 9), alongside the existing generation bump
	p.mu.Unlock()
	p.lastAuthAt = p.now()
	p.authNotBefore = time.Time{}
	slog.Info("bmr: recovery download session refreshed", "expiresAt", descriptor.ExpiresAt)
	return nil
}

// maybeRefreshBeforeExpiry is the proactive refresh. It never blocks a
// download on a refresh another caller is running (TryLock), never sleeps,
// and a failure only logs and schedules the next attempt: the current
// descriptor is still valid until expiresAt, and the reactive path takes
// over if it does lapse.
func (p *recoveryDownloadProvider) maybeRefreshBeforeExpiry() {
	expiresAt, ok := p.descriptorExpiry()
	if !ok {
		return
	}
	now := p.now()
	if now.Before(expiresAt.Add(-sessionRefreshLead)) {
		return
	}
	if !p.sessionMu.TryLock() {
		return
	}
	defer p.sessionMu.Unlock()

	if !p.proactiveFor.Equal(expiresAt) {
		p.proactiveFor = expiresAt
		p.proactiveAttempts = 0
	}
	if p.proactiveAttempts >= proactiveMaxAttempts ||
		now.Sub(p.lastAuthAt) < proactiveRefreshMinInterval ||
		now.Before(p.authNotBefore) {
		return
	}
	p.proactiveAttempts++

	if err := p.authenticateAndSwap(); err != nil {
		wait := proactiveRetryInterval
		var statusErr *authenticateStatusError
		if errors.As(err, &statusErr) && statusErr.retryAfter > wait {
			wait = statusErr.retryAfter
		}
		wait = sessionRetryJitter(wait)
		p.authNotBefore = now.Add(wait)
		slog.Warn("bmr: proactive recovery session refresh failed; continuing on the current session",
			"expiresAt", expiresAt, "attempt", p.proactiveAttempts, "nextAttemptIn", wait, "error", err.Error())
	}
}

// refreshAfterUnauthorized is the reactive refresh after a download on
// generation observed answered 401. Single-flight: if another caller already
// refreshed past observed, it returns nil at once and the caller retries on
// the new descriptor. Otherwise it authenticates with bounded backoff and
// returns nil on success, the context error if cancelled, or the (sticky)
// ErrRecoverySessionLost.
func (p *recoveryDownloadProvider) refreshAfterUnauthorized(observed uint64) error {
	p.sessionMu.Lock()
	defer p.sessionMu.Unlock()

	if err := p.sessionLost(); err != nil {
		return err
	}
	if p.sessionGeneration() != observed {
		return nil
	}

	delay := reauthInitialDelay
	rateLimited := 0
	var rateLimitedWaited time.Duration
	for attempt := 1; ; attempt++ {
		if wait := p.authNotBefore.Sub(p.now()); wait > 0 {
			slog.Warn("bmr: waiting before re-authenticating the recovery session", "wait", wait)
			if err := retrySleep(p.ctx, wait); err != nil {
				return fmt.Errorf("bmr: cancelled while waiting to re-authenticate the recovery session: %w", err)
			}
		}

		err := p.authenticateAndSwap()
		if err == nil {
			return nil
		}
		if ctxErr := p.ctx.Err(); ctxErr != nil {
			return fmt.Errorf("bmr: re-authenticate cancelled: %w", ctxErr)
		}

		// A capability downgrade — whether detected locally by
		// authenticateAndSwap (the fresh descriptor silently dropped the
		// capability, ErrCapabilityDowngrade) or reported by the server as
		// a terminal 409 capability_downgrade — can never be fixed by
		// retrying: keep the previous (still-capable) descriptor in place
		// and refuse immediately (review finding #3).
		if errors.Is(err, ErrCapabilityDowngrade) {
			return p.markSessionLost(err)
		}

		// Any other negotiation 409 from /bmr/recover/authenticate
		// (client_capability_required, storage_identity_drift,
		// snapshot_storage_identity_unknown, snapshot_index_failed) is
		// also terminal EXCEPT snapshot_index_pending, which means "come
		// back shortly" — honour the server's RetryAfterSeconds (bounded
		// by the same reauthMaxAttempts cap as every other reactive
		// attempt) rather than treating it as a hard refusal.
		// *RecoveryNegotiationError is a distinct type from
		// *authenticateStatusError (both are 409s, decoded differently by
		// authenticateRecoverySessionContext) — a bare
		// errors.As(err, &statusErr) below never matches it, which is
		// exactly why this case must be handled first.
		var negErr *RecoveryNegotiationError
		if errors.As(err, &negErr) {
			if negErr.Code == "capability_downgrade" {
				// Fold the server-reported code into the same sentinel a
				// local downgrade detection uses, so callers can match
				// either signal with one errors.Is check while
				// errors.As(&negErr) still recovers the code/message.
				return p.markSessionLost(fmt.Errorf("%w: %w", ErrCapabilityDowngrade, err))
			}
			if negErr.Code != "snapshot_index_pending" {
				return p.markSessionLost(err)
			}
			if attempt-rateLimited >= reauthMaxAttempts {
				return p.markSessionLost(fmt.Errorf("re-authenticate still pending after %d attempts: %w", attempt, err))
			}
			wait := time.Duration(negErr.RetryAfterSeconds) * time.Second
			if wait <= 0 {
				wait = delay
			}
			p.authNotBefore = p.now().Add(wait)
			slog.Warn("bmr: recovery session index not ready yet, retrying re-authenticate",
				"attempt", attempt, "wait", wait, "code", negErr.Code)
			delay *= 2
			if delay > reauthMaxDelay {
				delay = reauthMaxDelay
			}
			continue
		}

		var statusErr *authenticateStatusError
		isStatus := errors.As(err, &statusErr)
		switch {
		case isStatus && statusErr.statusCode == http.StatusTooManyRequests:
			// #12566: wait out the server's Retry-After (else the backoff),
			// within a total budget, instead of giving up after a few
			// quick tries. These calls do not count toward
			// reauthMaxAttempts.
			rateLimited++
			if rateLimited >= reauthMaxRateLimitedAttempts {
				return p.markSessionLost(fmt.Errorf("re-authenticate rate-limited %d times in a row: %w", rateLimited, err))
			}
			wait := delay
			if statusErr.retryAfter > 0 {
				wait = statusErr.retryAfter
			}
			if rateLimitedWaited+wait > reauthRateLimitedBudget {
				return p.markSessionLost(fmt.Errorf("re-authenticate still rate-limited after waiting %s: %w", rateLimitedWaited, err))
			}
			rateLimitedWaited += wait
			p.authNotBefore = p.now().Add(sessionRetryJitter(wait))
			slog.Warn("bmr: re-authenticate rate-limited, waiting before the next try",
				"attempt", attempt, "wait", wait, "waitedSoFar", rateLimitedWaited)
			delay *= 2
			if delay > reauthMaxDelay {
				delay = reauthMaxDelay
			}
			continue
		case isStatus && statusErr.statusCode >= 400 && statusErr.statusCode < 500,
			errors.Is(err, errRefreshMissingDescriptor):
			// The server rejected the token (revoked, expired, used) or
			// answered without a way to download: no retry can fix it.
			return p.markSessionLost(fmt.Errorf("re-authenticate rejected: %w", err))
		}
		if attempt-rateLimited >= reauthMaxAttempts {
			return p.markSessionLost(fmt.Errorf("re-authenticate failed after %d attempts: %w", attempt, err))
		}

		wait := delay
		if isStatus && statusErr.retryAfter > 0 {
			wait = statusErr.retryAfter
		}
		p.authNotBefore = p.now().Add(wait)
		slog.Warn("bmr: re-authenticate failed, backing off", "attempt", attempt, "wait", wait, "error", err.Error())

		delay *= 2
		if delay > reauthMaxDelay {
			delay = reauthMaxDelay
		}
	}
}
