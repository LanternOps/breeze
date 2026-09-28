package main

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/state"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

const (
	testPBTSuspend         = 0x0004
	testPBTResumeAutomatic = 0x0012
	testPBTPowerStatus     = 0x000A
)

func TestForwardPowerEventQueuesSuspendAndResumeOnly(t *testing.T) {
	t.Parallel()
	ch := make(chan powerNotice, 4)
	at := time.Now()

	if !forwardPowerEvent(ch, testPBTSuspend, at) {
		t.Fatal("suspend should be queued")
	}
	if !forwardPowerEvent(ch, testPBTResumeAutomatic, at) {
		t.Fatal("resume should be queued")
	}
	// AC/battery status changes are frequent and irrelevant to staleness.
	if forwardPowerEvent(ch, testPBTPowerStatus, at) {
		t.Fatal("power-status change must not be queued")
	}
	if got := len(ch); got != 2 {
		t.Fatalf("queued %d notices, want 2", got)
	}
	if n := <-ch; n.eventType != testPBTSuspend || !n.at.Equal(at) {
		t.Fatalf("first notice = %+v, want suspend at %v", n, at)
	}
}

func TestForwardPowerEventNeverBlocksTheSCMHandler(t *testing.T) {
	t.Parallel()
	ch := make(chan powerNotice) // unbuffered, nobody reading

	done := make(chan bool, 1)
	go func() { done <- forwardPowerEvent(ch, testPBTResumeAutomatic, time.Now()) }()
	select {
	case queued := <-done:
		if queued {
			t.Fatal("reported queued on a channel nobody reads")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("forwardPowerEvent blocked the SCM handler goroutine")
	}
}

func TestApplyPowerNoticeResumeGracesStaleHeartbeat(t *testing.T) {
	t.Parallel()
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	hc := watchdog.NewHealthChecker(nil, nil, 3*time.Minute)
	s := &state.AgentState{LastHeartbeat: time.Now().Add(-40 * time.Minute)}

	applyPowerNotice(powerNotice{eventType: testPBTSuspend, at: time.Now()}, hc, journal)
	if got := hc.CheckHeartbeatStaleness(s); got != watchdog.CheckHeartbeatStale {
		t.Fatalf("a suspend notice must not grant a grace, got %q", got)
	}

	applyPowerNotice(powerNotice{eventType: testPBTResumeAutomatic, at: time.Now()}, hc, journal)
	if got := hc.CheckHeartbeatStaleness(s); got != watchdog.CheckOK {
		t.Fatalf("resume notice must grace the sleep-inflated heartbeat age, got %q", got)
	}

	var events []string
	for _, e := range journal.Recent(10) {
		events = append(events, e.Event)
	}
	if len(events) != 2 || events[0] != "power.suspend" || events[1] != "power.resume" {
		t.Fatalf("journal events = %v, want [power.suspend power.resume]", events)
	}
}
