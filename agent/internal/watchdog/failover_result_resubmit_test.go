package watchdog

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// #7365, watchdog failover leg. The server answers a command result it could
// not record with HTTP 500 {"error":"result_processing_failed"} and parks the
// row as reopenable; the watchdog must resubmit it a bounded number of times.

func newResubmitTestClient(url string) *FailoverClient {
	c := NewFailoverClient(url, "agent-1", "tok", nil)
	c.resultResendDelay = func(int) time.Duration { return time.Millisecond }
	return c
}

func resultServer(t *testing.T, hits *atomic.Int32, answer func(n int32, w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/result") {
			http.NotFound(w, r)
			return
		}
		answer(hits.Add(1), w)
	}))
}

func writeProcessingFailed(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusInternalServerError)
	_, _ = w.Write([]byte(`{"error":"result_processing_failed"}`))
}

func TestFailoverSubmitResult_ResubmitsWhenServerCouldNotRecordIt(t *testing.T) {
	var hits atomic.Int32
	srv := resultServer(t, &hits, func(n int32, w http.ResponseWriter) {
		if n == 1 {
			writeProcessingFailed(w)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	defer srv.Close()

	if err := newResubmitTestClient(srv.URL).SubmitCommandResult("cmd-1", "completed", nil, ""); err != nil {
		t.Fatalf("SubmitCommandResult = %v, want success after one resubmission", err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("server saw %d submissions, want 2", got)
	}
}

func TestFailoverSubmitResult_GivesUpAfterAttemptCap(t *testing.T) {
	var hits atomic.Int32
	srv := resultServer(t, &hits, func(_ int32, w http.ResponseWriter) { writeProcessingFailed(w) })
	defer srv.Close()

	err := newResubmitTestClient(srv.URL).SubmitCommandResult("cmd-cap", "completed", nil, "")
	if err == nil {
		t.Fatal("SubmitCommandResult reported success while the server never recorded the result")
	}
	if !strings.Contains(err.Error(), "result_processing_failed") {
		t.Fatalf("give-up error %q does not name the server's reason", err)
	}
	if got, want := hits.Load(), int32(1+failoverResultResendMaxAttempts); got != want {
		t.Fatalf("server saw %d submissions, want exactly %d", got, want)
	}
}

// Only the parked-row answer is resubmitted. Any other failure keeps its
// existing single-attempt behaviour: a generic 5xx in FAILOVER means the
// server itself is unhealthy, and a 4xx will not change on resubmission.
func TestFailoverSubmitResult_OtherFailuresAreNotResubmitted(t *testing.T) {
	for _, tc := range []struct {
		name string
		code int
		body string
	}{
		{"plain 500", http.StatusInternalServerError, `{"error":"Internal Server Error"}`},
		{"502", http.StatusBadGateway, `bad gateway`},
		{"400", http.StatusBadRequest, `{"error":"result_processing_failed"}`},
		{"404", http.StatusNotFound, `{"error":"Command not found"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var hits atomic.Int32
			srv := resultServer(t, &hits, func(_ int32, w http.ResponseWriter) {
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(tc.body))
			})
			defer srv.Close()

			if err := newResubmitTestClient(srv.URL).SubmitCommandResult("cmd-x", "completed", nil, ""); err == nil {
				t.Fatal("SubmitCommandResult reported success on a failure status")
			}
			if got := hits.Load(); got != 1 {
				t.Fatalf("server saw %d submissions, want 1 (no resubmission)", got)
			}
		})
	}
}

func TestFailoverResultResendDelay_Bounded(t *testing.T) {
	for attempt := 1; attempt <= failoverResultResendMaxAttempts; attempt++ {
		for i := 0; i < 50; i++ {
			d := failoverResultResendDelay(attempt)
			if d <= 0 || d > 15*time.Second {
				t.Fatalf("attempt %d delay %v outside (0, 15s]; the watchdog loop runs this synchronously", attempt, d)
			}
		}
	}
}
