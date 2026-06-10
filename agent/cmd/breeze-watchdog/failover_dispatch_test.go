package main

import (
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

func hasJournalEvent(entries []watchdog.JournalEntry, event string) bool {
	for _, entry := range entries {
		if entry.Event == event {
			return true
		}
	}
	return false
}
