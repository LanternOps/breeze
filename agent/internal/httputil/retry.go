package httputil

import (
	"bytes"
	"context"
	"io"
	"math/rand/v2"
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
// next sleep instead of the internal exponential delay. This prevents fleets
// of agents from steamrolling server-side rate limits.
func Do(ctx context.Context, client *http.Client, method, url string, body []byte, headers http.Header, cfg RetryConfig) (*http.Response, error) {
	var lastErr error
	delay := cfg.InitialDelay
	// nextSleepOverride, if non-zero, replaces the exponential delay for the
	// next attempt's pre-sleep. It's set when the server sends Retry-After.
	var nextSleepOverride time.Duration

	for attempt := 0; attempt <= cfg.MaxRetries; attempt++ {
		if attempt > 0 {
			var sleepFor time.Duration
			if nextSleepOverride > 0 {
				// Honor server-provided Retry-After. ParseRetryAfter already
				// caps at 300s defensively.
				//
				// Issue #2728: jitter this too. A server-side rate limit is
				// usually tripped by the WHOLE fleet at once, so every agent
				// receives the same Retry-After (the per-org limiter sends a
				// flat "60") at the same instant. Sleeping exactly that long
				// re-synchronizes the fleet and guarantees the retry lands as
				// another simultaneous burst — the limiter then rejects it
				// again, and the agents stay in lockstep. The jitter is
				// strictly ADDITIVE so we never retry earlier than the server
				// asked; it only smears the herd forward over a window.
				sleepFor = applyPositiveJitter(nextSleepOverride, cfg.JitterFrac)
				log.Debug("honoring Retry-After from server",
					"attempt", attempt,
					"retryAfter", nextSleepOverride,
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
				return nil, ctx.Err()
			case <-time.After(sleepFor):
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
		if ra := ParseRetryAfter(resp.Header, time.Now()); ra > 0 {
			nextSleepOverride = ra
		}
		resp.Body.Close()
		lastErr = &RetryableStatusError{StatusCode: resp.StatusCode, URL: url}
	}

	log.Warn("all retries exhausted",
		"method", method,
		"url", url,
		"attempts", cfg.MaxRetries+1,
		"error", lastErr,
	)
	return nil, lastErr
}

// RetryableStatusError indicates the server returned a retryable HTTP status.
type RetryableStatusError struct {
	StatusCode int
	URL        string
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
	result := time.Duration(float64(d) * (1 + frac*rand.Float64()))
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
	jitter := float64(d) * frac * (2*rand.Float64() - 1)
	result := time.Duration(float64(d) + jitter)
	if result < 0 {
		return 0
	}
	return result
}
