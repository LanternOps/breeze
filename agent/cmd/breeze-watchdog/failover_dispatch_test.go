package main

import (
	"reflect"
	"testing"

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
