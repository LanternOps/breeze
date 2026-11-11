package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// #11154: the Windows uninstall helper retries its final result post, and
// must tell a rate limit (retry after the server's delay) from a refusal it
// should not repeat. A non-200 is therefore a typed *ErrHTTPStatus carrying
// the status and any Retry-After.
func TestSubmitCommandResultReturnsTypedStatusError(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/agents/agent-1/commands/cmd-1/result" || r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("unexpected request %s %s auth=%q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"Rate limit exceeded"}`))
	}))
	defer ts.Close()

	err := NewClient(ts.URL, "tok", "agent-1").SubmitCommandResult("cmd-1", map[string]string{"status": "completed"})
	var httpErr *ErrHTTPStatus
	if !errors.As(err, &httpErr) {
		t.Fatalf("error = %v (%T), want *ErrHTTPStatus", err, err)
	}
	if httpErr.StatusCode != http.StatusTooManyRequests || httpErr.RetryAfter != 7*time.Second {
		t.Fatalf("got %+v, want 429 with Retry-After 7s", httpErr)
	}
}

func TestSubmitCommandResultOK(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer ts.Close()
	if err := NewClient(ts.URL, "tok", "agent-1").SubmitCommandResult("cmd-1", map[string]string{}); err != nil {
		t.Fatal(err)
	}
}
