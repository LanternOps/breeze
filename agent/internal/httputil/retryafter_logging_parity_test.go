package httputil

import (
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

// logging keeps a private copy of this parser (httputil imports logging, so
// logging cannot import httputil). These tests pin the copies together.

func TestRetryAfterMaxCapMatchesLogging(t *testing.T) {
	if retryAfterMaxCap != logging.RetryAfterMaxCap {
		t.Fatalf("httputil retryAfterMaxCap = %v, logging.RetryAfterMaxCap = %v; they must be equal",
			retryAfterMaxCap, logging.RetryAfterMaxCap)
	}
}

// retryAfterParityCases: keep in step with the table in
// internal/logging/retryafter_test.go (TestParseRetryAfterParityTable).
func TestParseRetryAfterParityTable(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name   string
		header string
		want   time.Duration
	}{
		{"empty", "", 0},
		{"zero", "0", 0},
		{"negative", "-5", 0},
		{"garbage", "abc", 0},
		{"thirty", "30", 30 * time.Second},
		{"at cap", "300", 300 * time.Second},
		{"over cap", "99999", 300 * time.Second},
		{"http-date 90s ahead", now.Add(90 * time.Second).Format(http.TimeFormat), 90 * time.Second},
		{"http-date in the past", now.Add(-time.Hour).Format(http.TimeFormat), 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{}
			if tc.header != "" {
				h.Set("Retry-After", tc.header)
			}
			if got := ParseRetryAfter(h, now); got != tc.want {
				t.Fatalf("ParseRetryAfter(%q) = %v, want %v", tc.header, got, tc.want)
			}
		})
	}
}
