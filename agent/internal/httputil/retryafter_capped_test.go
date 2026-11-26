package httputil

import (
	"net/http"
	"testing"
	"time"
)

// ParseRetryAfterCapped is ParseRetryAfter with a caller-chosen ceiling, for
// callers whose back-off is measured in minutes or hours, not seconds (#12713).

func TestParseRetryAfterCappedSecondsAboveDefaultCap(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "1800")

	if got, want := ParseRetryAfterCapped(h, time.Now(), 6*time.Hour), 30*time.Minute; got != want {
		t.Fatalf("ParseRetryAfterCapped(\"1800\", 6h) = %v, want %v", got, want)
	}
}

func TestParseRetryAfterCappedSecondsClampedToCeiling(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "86400")

	if got, want := ParseRetryAfterCapped(h, time.Now(), 6*time.Hour), 6*time.Hour; got != want {
		t.Fatalf("ParseRetryAfterCapped(\"86400\", 6h) = %v, want %v", got, want)
	}
}

func TestParseRetryAfterCappedHugeSecondsDoNotOverflow(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "99999999999999")

	if got, want := ParseRetryAfterCapped(h, time.Now(), 6*time.Hour), 6*time.Hour; got != want {
		t.Fatalf("ParseRetryAfterCapped(huge) = %v, want %v", got, want)
	}
}

func TestParseRetryAfterCappedHTTPDate(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	h := http.Header{}
	h.Set("Retry-After", now.Add(2*time.Hour).Format(http.TimeFormat))

	if got, want := ParseRetryAfterCapped(h, now, 6*time.Hour), 2*time.Hour; got != want {
		t.Fatalf("ParseRetryAfterCapped(date +2h, 6h) = %v, want %v", got, want)
	}
}

func TestParseRetryAfterCappedRejectsMissingMalformedAndPast(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	for name, value := range map[string]string{
		"empty":     "",
		"malformed": "soon",
		"zero":      "0",
		"negative":  "-5",
		"past date": now.Add(-time.Hour).Format(http.TimeFormat),
	} {
		t.Run(name, func(t *testing.T) {
			h := http.Header{}
			if value != "" {
				h.Set("Retry-After", value)
			}
			if got := ParseRetryAfterCapped(h, now, 6*time.Hour); got != 0 {
				t.Fatalf("ParseRetryAfterCapped(%q) = %v, want 0", value, got)
			}
		})
	}
	if got := ParseRetryAfterCapped(nil, now, 6*time.Hour); got != 0 {
		t.Fatalf("ParseRetryAfterCapped(nil) = %v, want 0", got)
	}
}

// ParseRetryAfter keeps its 300 s cap: the shared retry paths rely on it.
func TestParseRetryAfterKeepsDefaultCap(t *testing.T) {
	h := http.Header{}
	h.Set("Retry-After", "1800")

	if got, want := ParseRetryAfter(h, time.Now()), 300*time.Second; got != want {
		t.Fatalf("ParseRetryAfter(\"1800\") = %v, want %v", got, want)
	}
}
