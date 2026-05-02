package logging

import (
	"net/http"
	"strconv"
	"time"
)

// retryAfterMaxCap is the defensive maximum we will honor from a server-provided
// Retry-After header. Mirrors httputil.retryAfterMaxCap; duplicated here to
// avoid a circular import (httputil already imports logging).
const retryAfterMaxCap = 300 * time.Second

// parseRetryAfter returns the duration to wait per RFC 7231 §7.1.3.
//
// The Retry-After header may be either:
//   - An integer number of seconds (e.g. "30")
//   - An HTTP-date (RFC1123, RFC1123Z, or asctime — see http.ParseTime)
//
// The returned duration is always clamped to [0, retryAfterMaxCap]. The function
// returns 0 if the header is missing, malformed, zero, or in the past.
//
// Unexported because callers outside this package should use
// httputil.ParseRetryAfter — this is a duplicate kept private to avoid the
// import cycle (httputil → logging).
func parseRetryAfter(h http.Header, now time.Time) time.Duration {
	if h == nil {
		return 0
	}
	raw := h.Get("Retry-After")
	if raw == "" {
		return 0
	}

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

	return 0
}
