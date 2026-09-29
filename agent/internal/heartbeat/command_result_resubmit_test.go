package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #7365, REST leg of the main agent. Since #3530 the server answers a command
// result it could not record with HTTP 500 {"error":"result_processing_failed"}
// and parks the row as reopenable, so a resubmission is reprocessed (and a
// duplicate after a successful record is a 0-row CAS no-op). submitCommandResult
// already rides httputil.Do with the production retry config, which retries 500
// with jittered backoff — these tests pin that the parked-row answer IS
// resubmitted, and that the resubmission is bounded.

func fastProductionRetryConfig() httputil.RetryConfig {
	cfg := httputil.DefaultRetryConfig() // the config New() installs
	cfg.InitialDelay = time.Millisecond
	cfg.MaxDelay = time.Millisecond
	return cfg
}

func newResultSubmitHeartbeat(serverURL string) *Heartbeat {
	h := newRecoveryMarkerTestHeartbeat(&config.Config{AgentID: "agent-1", ServerURL: serverURL, AuthToken: "t"})
	h.retryCfg = fastProductionRetryConfig()
	return h
}

func TestSubmitCommandResult_ResubmitsWhenServerCouldNotRecordIt(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/commands/cmd-rest/result") {
			http.NotFound(w, r)
			return
		}
		if hits.Add(1) == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"result_processing_failed"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	h := newResultSubmitHeartbeat(srv.URL)
	if err := h.submitCommandResult("cmd-rest", tools.CommandResult{Status: "completed", Stdout: "ok"}); err != nil {
		t.Fatalf("submitCommandResult = %v, want success after one resubmission", err)
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("server saw %d submissions, want 2 (original + resubmission)", got)
	}
}

func TestSubmitCommandResult_GivesUpAfterBoundedResubmissions(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"result_processing_failed"}`))
	}))
	defer srv.Close()

	h := newResultSubmitHeartbeat(srv.URL)
	if err := h.submitCommandResult("cmd-rest-cap", tools.CommandResult{Status: "completed"}); err == nil {
		t.Fatal("submitCommandResult reported success while the server never recorded the result")
	}
	want := int32(httputil.DefaultRetryConfig().MaxRetries + 1)
	if want < 2 {
		t.Fatalf("production retry config makes %d attempt(s); a parked result would never be resubmitted", want)
	}
	if got := hits.Load(); got != want {
		t.Fatalf("server saw %d submissions, want exactly %d (bounded)", got, want)
	}
}
