package httputil

import (
	"net/http"
	"strconv"
	"time"
)

// retryAfterMaxCap is the defensive maximum we will honor from a server-provided
// Retry-After header. Without this cap, a hostile or misconfigured server could
// park agents for hours by sending Retry-After: 99999.
const retryAfterMaxCap = 300 * time.Second

// ParseRetryAfter returns the duration to wait per RFC 7231 §7.1.3.
//
// The Retry-After header may be either:
//   - An integer number of seconds (e.g. "30")
//   - An HTTP-date (RFC1123, RFC1123Z, or asctime — see http.ParseTime)
//
// The returned duration is always clamped to [0, retryAfterMaxCap]. The function
// returns 0 if the header is missing, malformed, zero, or in the past.
func ParseRetryAfter(h http.Header, now time.Time) time.Duration {
	if h == nil {
		return 0
	}
	raw := h.Get("Retry-After")
	if raw == "" {
		return 0
	}

	// Try integer seconds first (the common case).
	if secs, err := strconv.Atoi(raw); err == nil {
		if secs <= 0 {
			return 0
		}
		d := time.Duration(secs) * time.Second
		if d > retryAfterMaxCap {
			return retryAfterMaxCap
		}
		return d
	}

	// Fall back to HTTP-date parsing (RFC 7231 allows three formats).
	if t, err := http.ParseTime(raw); err == nil {
		d := t.Sub(now)
		if d <= 0 {
			return 0
		}
		if d > retryAfterMaxCap {
			return retryAfterMaxCap
		}
		return d
	}

	// Malformed value — caller falls back to its own delay logic.
	return 0
}
