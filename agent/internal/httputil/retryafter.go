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
	return ParseRetryAfterCapped(h, now, retryAfterMaxCap)
}

// ParseRetryAfterCapped is ParseRetryAfter with a caller-chosen ceiling in
// place of the 300 s default, for callers whose back-off is measured in
// minutes or hours (the workspace index waits out a disabled module, #12713).
// The result is clamped to [0, maxWait]; 0 means missing, malformed, zero or
// in the past, and the caller falls back to its own delay.
func ParseRetryAfterCapped(h http.Header, now time.Time, maxWait time.Duration) time.Duration {
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
		// Compare before multiplying: a huge value would overflow
		// time.Duration and wrap negative.
		if time.Duration(secs) > maxWait/time.Second {
			return maxWait
		}
		return time.Duration(secs) * time.Second
	}

	// Fall back to HTTP-date parsing (RFC 7231 allows three formats).
	if t, err := http.ParseTime(raw); err == nil {
		d := t.Sub(now)
		if d <= 0 {
			return 0
		}
		if d > maxWait {
			return maxWait
		}
		return d
	}

	// Malformed value — caller falls back to its own delay logic.
	return 0
}
