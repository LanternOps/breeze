package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/watchdog"
)

// TestProcessHeartbeatResponse_ExecutesInlineCommands is a regression test for
// #1103. The server claims pending watchdog-targeted commands during the
// heartbeat itself (marking them 'sent') and returns them inline on the
// heartbeat response, so the separate command poll never sees them. Before the
// fix, processHeartbeatResponse ignored resp.Commands, so a watchdog-targeted
// command (e.g. restart_agent) was consumed but never executed.
//
// An unknown command type is used so the dispatch path is exercised end to end
// (handleFailoverCommand -> SubmitCommandResult) without triggering a real
// service restart. wd/cfg/tokens/recovery are unused for an unknown type, so
// nil is safe.
func TestProcessHeartbeatResponse_ExecutesInlineCommands(t *testing.T) {
	var (
		mu        sync.Mutex
		gotResult bool
		gotStatus string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/commands/cmd-test-1/result") {
			body, _ := io.ReadAll(r.Body)
			var parsed map[string]any
			_ = json.Unmarshal(body, &parsed)
			mu.Lock()
			gotResult = true
			gotStatus, _ = parsed["status"].(string)
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	fc := watchdog.NewFailoverClient(srv.URL, "agent-1", "token", nil)
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("NewJournal: %v", err)
	}

	resp := &watchdog.HeartbeatResponse{
		Commands: []watchdog.FailoverCommand{
			{ID: "cmd-test-1", Type: "unknown_test_command"},
		},
	}

	processHeartbeatResponse(fc, resp, nil, journal, nil, nil, nil)

	mu.Lock()
	defer mu.Unlock()
	if !gotResult {
		t.Fatal("inline heartbeat command was not dispatched (SubmitCommandResult never called) — #1103 regression")
	}
	if gotStatus != "failed" {
		t.Fatalf("expected status \"failed\" for an unknown command type, got %q", gotStatus)
	}
}
