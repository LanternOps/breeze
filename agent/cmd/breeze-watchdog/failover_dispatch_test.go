package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// #1103 — the watchdog failover loop sends a heartbeat (which the server
// claims + marks 'sent', returning the commands inline) and THEN polls
// (which only returns still-'pending' commands). Commands delivered by the
// heartbeat must be executed; previously they were dropped. The poll set is
// deduped against the heartbeat set so a command never runs twice.

func runIDs(heartbeat, poll []watchdog.FailoverCommand) []string {
	var ran []string
	executeFailoverCommands(heartbeat, poll, func(cmd watchdog.FailoverCommand) {
		ran = append(ran, cmd.ID)
	})
	return ran
}

func cmds(ids ...string) []watchdog.FailoverCommand {
	out := make([]watchdog.FailoverCommand, 0, len(ids))
	for _, id := range ids {
		out = append(out, watchdog.FailoverCommand{ID: id, Type: "collect_diagnostics"})
	}
	return out
}

func TestExecuteFailoverCommands_RunsHeartbeatDeliveredCommands(t *testing.T) {
	// The core #1103 regression: a command delivered ONLY by the heartbeat
	// (poll returns nothing because it was already marked 'sent') must run.
	ran := runIDs(cmds("hb-1"), nil)
	if !reflect.DeepEqual(ran, []string{"hb-1"}) {
		t.Fatalf("expected heartbeat command to execute, got %v", ran)
	}
}

func TestExecuteFailoverCommands_RunsPollDeliveredCommands(t *testing.T) {
	ran := runIDs(nil, cmds("poll-1"))
	if !reflect.DeepEqual(ran, []string{"poll-1"}) {
		t.Fatalf("expected poll command to execute, got %v", ran)
	}
}

func TestExecuteFailoverCommands_DedupesOverlappingIDs(t *testing.T) {
	// Same command surfaced by both paths must execute exactly once.
	ran := runIDs(cmds("x"), cmds("x"))
	if !reflect.DeepEqual(ran, []string{"x"}) {
		t.Fatalf("expected deduped single execution, got %v", ran)
	}
}

func TestExecuteFailoverCommands_HeartbeatBeforePollPreservingOrder(t *testing.T) {
	ran := runIDs(cmds("hb-1", "hb-2"), cmds("hb-1", "poll-1"))
	// hb-1, hb-2 from heartbeat (in order); poll-1 from poll; the poll's
	// duplicate hb-1 is skipped.
	want := []string{"hb-1", "hb-2", "poll-1"}
	if !reflect.DeepEqual(ran, want) {
		t.Fatalf("expected %v, got %v", want, ran)
	}
}

func TestCurrentRestartStats_DisablesFlapDetectionWhenThresholdUnset(t *testing.T) {
	recovery := watchdog.NewRecoveryManager(3, 0)
	stats := currentRestartStats(recovery, 0)
	if stats.FlapDetected {
		t.Fatal("expected unset max restarts threshold to disable flap detection")
	}
}

func TestProcessInitialFailoverHeartbeatResponse_ExecutesCommandsAndProcessesUpgrades(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer journal.Close()

	cfg := &config.Config{
		AgentID:   "agent-1",
		ServerURL: "https://example.invalid",
	}
	wd := watchdog.NewWatchdog(watchdog.Config{})
	tokens := &tokenHolder{}
	recovery := watchdog.NewRecoveryManager(3, 0)

	resp := &watchdog.HeartbeatResponse{
		Commands: []watchdog.FailoverCommand{
			{ID: "cmd-initial", Type: "collect_diagnostics"},
		},
		UpgradeTo:         "2.0.0",
		WatchdogUpgradeTo: "2.1.0",
	}

	var ran []string
	processInitialFailoverHeartbeatResponse(resp, wd, journal, cfg, tokens, recovery, func(cmd watchdog.FailoverCommand) {
		ran = append(ran, cmd.ID)
	})

	if !reflect.DeepEqual(ran, []string{"cmd-initial"}) {
		t.Fatalf("expected initial heartbeat command to execute, got %v", ran)
	}

	events := journal.Recent(0)
	for _, tc := range []struct {
		name  string
		event string
	}{
		{name: "agent upgrade", event: "failover.upgrade_agent"},
		{name: "watchdog upgrade", event: "failover.upgrade_watchdog"},
	} {
		if !hasJournalEvent(events, tc.event) {
			t.Fatalf("expected %s event %q in journal, got %#v", tc.name, tc.event, events)
		}
	}
}

func TestHandleWatchdogCommandPoll_ExecutesCommandsWhileMonitoring(t *testing.T) {
	var resultCommandID string
	var resultStatus string
	var heartbeatCalled bool

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/agent-1/heartbeat":
			if got := r.Header.Get("X-Breeze-Role"); got != "watchdog" {
				t.Errorf("X-Breeze-Role = %q, want watchdog", got)
				http.Error(w, "bad role header", http.StatusBadRequest)
				return
			}
			var body struct {
				Role          string `json:"role"`
				WatchdogState string `json:"watchdogState"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode heartbeat body: %v", err)
				http.Error(w, "bad heartbeat body", http.StatusBadRequest)
				return
			}
			if body.Role != "watchdog" || body.WatchdogState != watchdog.StateMonitoring {
				t.Errorf("heartbeat role/state = %q/%q, want watchdog/%s", body.Role, body.WatchdogState, watchdog.StateMonitoring)
				http.Error(w, "bad heartbeat", http.StatusBadRequest)
				return
			}
			heartbeatCalled = true
			_ = json.NewEncoder(w).Encode(map[string]any{"commands": []watchdog.FailoverCommand{}})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/agents/agent-1/commands":
			if got := r.URL.Query().Get("role"); got != "watchdog" {
				t.Errorf("role query = %q, want watchdog", got)
				http.Error(w, "bad role", http.StatusBadRequest)
				return
			}
			if got := r.Header.Get("X-Breeze-Role"); got != "watchdog" {
				t.Errorf("X-Breeze-Role = %q, want watchdog", got)
				http.Error(w, "bad role header", http.StatusBadRequest)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"commands": []watchdog.FailoverCommand{
					{ID: "cmd-healthy", Type: "collect_diagnostics"},
				},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/agent-1/logs":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/agent-1/commands/cmd-healthy/result":
			var body struct {
				Status string `json:"status"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode result body: %v", err)
				http.Error(w, "bad result body", http.StatusBadRequest)
				return
			}
			resultCommandID = "cmd-healthy"
			resultStatus = body.Status
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer journal.Close()

	cfg := &config.Config{
		AgentID:   "agent-1",
		ServerURL: server.URL,
	}
	cfg.Watchdog.MaxRestartsPer24h = 5
	wd := watchdog.NewWatchdog(watchdog.Config{})
	wd.HandleEvent(watchdog.EventIPCConnected)
	recovery := watchdog.NewRecoveryManager(3, 0)
	client := watchdog.NewFailoverClient(server.URL, "agent-1", "tok-watchdog", nil)

	handleWatchdogCommandPoll(client, wd, journal, cfg, &tokenHolder{}, recovery)

	if !heartbeatCalled {
		t.Fatal("expected monitoring watchdog heartbeat before command poll")
	}
	if resultCommandID != "cmd-healthy" {
		t.Fatalf("result command id = %q, want cmd-healthy", resultCommandID)
	}
	if resultStatus != "completed" {
		t.Fatalf("result status = %q, want completed", resultStatus)
	}
}

func TestHandleWatchdogCommandPoll_ExecutesHeartbeatCommandsWhileMonitoring(t *testing.T) {
	var resultCommandID string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/agent-1/heartbeat":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"commands": []watchdog.FailoverCommand{
					{ID: "cmd-heartbeat", Type: "collect_diagnostics"},
				},
			})
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/agents/agent-1/commands":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"commands": []watchdog.FailoverCommand{},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/agent-1/logs":
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/agents/agent-1/commands/cmd-heartbeat/result":
			resultCommandID = "cmd-heartbeat"
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.String())
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer journal.Close()

	cfg := &config.Config{
		AgentID:   "agent-1",
		ServerURL: server.URL,
	}
	cfg.Watchdog.MaxRestartsPer24h = 5
	wd := watchdog.NewWatchdog(watchdog.Config{})
	wd.HandleEvent(watchdog.EventIPCConnected)
	recovery := watchdog.NewRecoveryManager(3, 0)
	client := watchdog.NewFailoverClient(server.URL, "agent-1", "tok-watchdog", nil)

	handleWatchdogCommandPoll(client, wd, journal, cfg, &tokenHolder{}, recovery)

	if resultCommandID != "cmd-heartbeat" {
		t.Fatalf("result command id = %q, want cmd-heartbeat", resultCommandID)
	}
}

func hasJournalEvent(entries []watchdog.JournalEntry, event string) bool {
	for _, entry := range entries {
		if entry.Event == event {
			return true
		}
	}
	return false
}
