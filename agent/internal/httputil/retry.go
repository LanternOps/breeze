package httputil

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("httputil")

// RetryConfig controls the retry behavior for HTTP requests.
type RetryConfig struct {
	MaxRetries    int
	InitialDelay  time.Duration
	MaxDelay      time.Duration
	BackoffFactor float64
	JitterFrac    float64 // ±fraction of delay to randomize (e.g. 0.3 = ±30%)
}

// DefaultRetryConfig returns sensible defaults for agent→server calls.
func DefaultRetryConfig() RetryConfig {
	return RetryConfig{
		MaxRetries:    3,
		InitialDelay:  1 * time.Second,
		MaxDelay:      30 * time.Second,
		BackoffFactor: 2.0,
		JitterFrac:    0.3,
	}
}

// isRetryableStatus returns true for HTTP status codes that are safe to retry.
func isRetryableStatus(code int) bool {
	return code == http.StatusTooManyRequests ||
		code == http.StatusInternalServerError ||
		code == http.StatusBadGateway ||
		code == http.StatusServiceUnavailable ||
		code == http.StatusGatewayTimeout
}

// Do executes an HTTP request with retry logic. The request body must be
// provided separately as a byte slice so it can be replayed on retries.
// Returns the response from the first successful (or last) attempt.
//
// When the server returns a retryable status (especially 429 or 503) with a
// Retry-After header, the parsed value (clamped to ≤300s) is honored for the
// next sleep instead of the internal exponential delay, with positive jitter.
// This prevents fleets of agents from steamrolling server-side rate limits.
//
// W09 (#8148): when that jittered delay will not fit in ctx's deadline, Do
// returns at once with the *RetryableStatusError, whose RetryAt (set while
// loop-level Retry-After is on, see SetLoopRetryAfter) tells the caller's
// loop when to call the route again.
func Do(ctx context.Context, client *http.Client, method, url string, body []byte, headers http.Header, cfg RetryConfig) (*http.Response, error) {
	var lastErr error
	delay := cfg.InitialDelay
	// nextSleepOverride, if non-zero, replaces the exponential delay for the
	// next attempt's pre-sleep. It's set when the server sends Retry-After.
	var nextSleepOverride time.Duration
	// lastAnswer is the most recent retryable status the server actually
	// answered with, kept separately from lastErr so a later transport
	// failure or context expiry cannot erase it (#8934).
	var lastAnswer *RetryableStatusError

	for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
		if attempt > 0 {
			var sleepFor time.Duration
			if nextSleepOverride > 0 {
				// Honor server-provided Retry-After, already jittered once
				// where the answer was read (see below), so the wait here and
				// the RetryAt carried on the error are the same instant.
				sleepFor = nextSleepOverride
				log.Debug("honoring Retry-After from server",
					"attempt", attempt,
					"delay", sleepFor,
					"url", url,
				)
				nextSleepOverride = 0
			} else {
				sleepFor = applyJitter(delay, cfg.JitterFrac)
				log.Debug("retrying request",
					"attempt", attempt,
					"delay", sleepFor,
					"url", url,
				)
			}
			select {
			case <-ctx.Done():
				return nil, withServerAnswer(ctx.Err(), lastAnswer)
			case <-afterFn(sleepFor):
			}

			// Exponential backoff for next attempt (used if server doesn't
			// send Retry-After next time around).
			delay = time.Duration(float64(delay) * cfg.BackoffFactor)
			if delay > cfg.MaxDelay {
				delay = cfg.MaxDelay
			}
		}

		var bodyReader io.Reader
		if body != nil {
			bodyReader = bytes.NewReader(body)
		}

		req, err := http.NewRequestWithContext(ctx, method, url, bodyReader)
		if err != nil {
			return nil, err // not retryable
		}
		for k, vals := range headers {
			for _, v := range vals {
				req.Header.Add(k, v)
			}
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue // network error — retry
		}

		if !isRetryableStatus(resp.StatusCode) {
			return resp, nil // success or non-retryable error
		}

		// Retryable status — check for Retry-After before discarding response.
		ra := ParseRetryAfter(resp.Header, nowFn())
		answer := &RetryableStatusError{StatusCode: resp.StatusCode, URL: url, RetryAfter: ra, AnsweredAt: time.Now()}
		if ra > 0 {
			// Issue #2728: jitter the server's delay. A server-side limit is
			// usually tripped by the WHOLE fleet at once, so every agent
			// receives the same Retry-After at the same instant; waiting
			// exactly that long re-synchronizes the fleet. The jitter is
			// strictly ADDITIVE (never sooner than asked) and drawn once, so
			// the in-request wait and RetryAt agree.
			wait := applyPositiveJitter(ra, cfg.JitterFrac)
			nextSleepOverride = wait
			if LoopRetryAfterEnabled() {
				answer.RetryAt = nowFn().Add(wait)
			}
		}
		resp.Body.Close()
		lastAnswer = answer
		lastErr = lastAnswer

		// W09 (#8148, D5): a Retry-After that will not fit in the caller's
		// context used to be slept into the deadline and then lost. Return
		// the answer now; its RetryAt lets the caller's loop skip its next
		// cycle until then. Remaining real time is compared with the wait, so
		// a faked nowFn is never compared with the context's real clock.
		if !answer.RetryAt.IsZero() && attempt < cfg.MaxRetries {
			if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < nextSleepOverride {
				log.Debug("retry-after exceeds caller deadline; returning RetryAt",
					"url", url,
					"status", answer.StatusCode,
					"wait", nextSleepOverride,
					"retryAt", answer.RetryAt,
				)
				return nil, answer
			}
		}
	}
	lastErr = withServerAnswer(lastErr, lastAnswer)

	log.Warn("all retries exhausted",
		"method", method,
		"url", url,
		"attempts", cfg.MaxRetries+1,
		"error", lastErr,
	)
	return nil, lastErr
}

// withServerAnswer returns err with the server's last retryable answer added to
// its chain when err does not already carry it. A server that answers 503 with
// a Retry-After longer than the caller's context used to surface as a bare
// context.DeadlineExceeded, indistinguishable from a dead network; the
// heartbeat needs to know the server answered (#8934). The context error stays
// first in the chain, so errors.Is(err, context.DeadlineExceeded) still holds.
func withServerAnswer(err error, answer *RetryableStatusError) error {
	if err == nil || answer == nil {
		return err
	}
	var already *RetryableStatusError
	if errors.As(err, &already) {
		return err
	}
	return fmt.Errorf("%w (server last answered %d: %w)", err, answer.StatusCode, answer)
}

// RetryableStatusError indicates the server returned a retryable HTTP status.
type RetryableStatusError struct {
	StatusCode int
	URL        string
	// RetryAt is when the server allows the next call to this route: now plus
	// its Retry-After with positive jitter (ParseRetryAfter caps the header at
	// 300 s, and the jitter is clamped back to it). Zero when the
	// answer carried no usable Retry-After, or loop-level Retry-After is off
	// (SetLoopRetryAfter). W09, #8148.
	RetryAt time.Time
	// RetryAfter is the server's Retry-After on that answer (0 if absent),
	// so a caller that retries on its own schedule can still honor it.
	RetryAfter time.Duration
	// AnsweredAt is when that answer arrived. Do may already have spent part
	// of RetryAfter sleeping before its context ended, so a caller waits
	// RetryAfter minus the time since AnsweredAt, not RetryAfter again.
	AnsweredAt time.Time
}

// RetryAtFrom returns the RetryAt carried anywhere in err's chain, and whether
// there was one.
func RetryAtFrom(err error) (time.Time, bool) {
	var rse *RetryableStatusError
	if errors.As(err, &rse) && !rse.RetryAt.IsZero() {
		return rse.RetryAt, true
	}
	return time.Time{}, false
}

func (e *RetryableStatusError) Error() string {
	return "request to " + e.URL + " failed after retries with status " + http.StatusText(e.StatusCode)
}

// applyPositiveJitter adds +[0, frac] random jitter to a duration — never
// negative. Used for server-provided Retry-After delays, where sleeping LESS
// than instructed would defeat the purpose, but where spreading a fleet of
// agents out over a window is essential to avoid a synchronized retry burst
// (issue #2728). The result is clamped to retryAfterMaxCap so the added jitter
// can't push a near-cap Retry-After far past the defensive ceiling.
func applyPositiveJitter(d time.Duration, frac float64) time.Duration {
	if frac <= 0 || d <= 0 {
		return d
	}
	result := time.Duration(float64(d) * (1 + frac*randFloat()))
	if result > retryAfterMaxCap {
		return retryAfterMaxCap
	}
	return result
}

// applyJitter adds ±frac random jitter to a duration.
func applyJitter(d time.Duration, frac float64) time.Duration {
	if frac <= 0 {
		return d
	}
	jitter := float64(d) * frac * (2*randFloat() - 1)
	result := time.Duration(float64(d) + jitter)
	if result < 0 {
		return 0
	}
	return result
}
