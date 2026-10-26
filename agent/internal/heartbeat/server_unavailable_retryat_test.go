package heartbeat

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
)

// W09 (#8148): httputil.Do now returns a long Retry-After at once, carrying
// RetryAt and no context error, instead of sleeping into the deadline. The
// #8934 liveness path must still see the overload answer (decision D2).
func TestHeartbeatOverloadAnswerWithRetryAtStillRecordsLiveness(t *testing.T) {
	err := fmt.Errorf("send: %w", &httputil.RetryableStatusError{
		StatusCode: http.StatusServiceUnavailable,
		URL:        "https://example.invalid/api/v1/agents/a/heartbeat",
		RetryAt:    time.Now().Add(5 * time.Minute),
	})
	if code, ok := serverOverloadAnswer(err); !ok || code != http.StatusServiceUnavailable {
		t.Fatalf("serverOverloadAnswer = (%d, %v), want (503, true)", code, ok)
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "300")
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	s, before, hb := postAgainst(t, srv.URL)
	if !s.ServerUnavailableAt.After(before) {
		t.Fatalf("ServerUnavailableAt = %v, want a fresh marker after a 503 + Retry-After: 300", s.ServerUnavailableAt)
	}
	if !s.LastHeartbeat.Equal(hb) {
		t.Fatalf("LastHeartbeat moved to %v on a 503", s.LastHeartbeat)
	}
}
