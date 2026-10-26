package websocket

import (
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// W09 (#8148, D11): with jittered reconnects a socket can stay down for up to
// 30 s (or a drain window). A command result accepted into the in-memory
// resultChan while disconnected has already cleared the durable command
// journal (OnResultHandedOff), so a hard kill in that window lost it. While no
// socket is held, command results now go to the durable outbox first.

type orderRecorder struct {
	mu    sync.Mutex
	order []string
}

func (o *orderRecorder) note(s string) {
	o.mu.Lock()
	o.order = append(o.order, s)
	o.mu.Unlock()
}

func (o *orderRecorder) get() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return slices.Clone(o.order)
}

func wireOutbox(c *Client, rec *orderRecorder) <-chan struct{} {
	handedOff := make(chan struct{}, 4)
	c.OnResultWriteFailed = func(r CommandResult) { rec.note("outbox:" + r.CommandID) }
	// Durable unless the id says ephemeral (the heartbeat uses journalable).
	c.PersistResultWhileDisconnected = func(cmd Command) bool { return !strings.HasPrefix(cmd.ID, "term-") }
	c.OnResultHandedOff = func(r CommandResult) {
		rec.note("handoff:" + r.CommandID)
		handedOff <- struct{}{}
	}
	return handedOff
}

func awaitHandoff(t *testing.T, ch <-chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second): // hang guard only
		t.Fatal("result never handed off")
	}
}

func TestResultWhileDisconnectedGoesToOutboxBeforeHandoff(t *testing.T) {
	c := newTestClient("http://127.0.0.1:1", func(cmd Command) CommandResult {
		return CommandResult{Status: "completed"}
	})
	rec := &orderRecorder{}
	handedOff := wireOutbox(c, rec)

	c.processCommand(Command{ID: "cmd-1", Type: "run_script"}) // never connected
	awaitHandoff(t, handedOff)

	if want := []string{"outbox:cmd-1", "handoff:cmd-1"}; !slices.Equal(rec.get(), want) {
		t.Fatalf("order = %v, want %v", rec.get(), want)
	}
	if n := len(c.resultChan); n != 0 {
		t.Fatalf("result buffered in memory while disconnected (%d queued)", n)
	}
}

func TestResultSentDirectlyIfSocketCameUpDuringOutboxWrite(t *testing.T) {
	s := newScriptedWSServer(t, nil)
	c := newTestClient(s.srv.URL, func(cmd Command) CommandResult {
		return CommandResult{Status: "completed"}
	})
	rec := &orderRecorder{}
	handedOff := wireOutbox(c, rec)
	c.OnResultWriteFailed = func(r CommandResult) {
		rec.note("outbox:" + r.CommandID)
		if err := c.connect(); err != nil { // the reconnect lands mid-write
			t.Errorf("connect: %v", err)
		}
	}
	t.Cleanup(c.Stop)

	c.processCommand(Command{ID: "cmd-up", Type: "run_script"})
	awaitHandoff(t, handedOff)
	s.next(t)
	if want := []string{"outbox:cmd-up", "handoff:cmd-up"}; !slices.Equal(rec.get(), want) {
		t.Fatalf("order = %v, want %v", rec.get(), want)
	}
	if n := len(c.resultChan); n != 1 {
		t.Fatalf("queued = %d, want 1: a socket that came up during the outbox write must also get the result", n)
	}
	<-c.resultChan // keep the cleanup Stop's outbox drain from double-noting it
}

func TestEphemeralResultWhileDisconnectedStillBuffers(t *testing.T) {
	// Terminal/tunnel/desktop/monitor results are not durable and far too
	// frequent for a disk write each: they keep buffering in memory.
	c := newTestClient("http://127.0.0.1:1", func(cmd Command) CommandResult {
		return CommandResult{Status: "completed"}
	})
	rec := &orderRecorder{}
	handedOff := wireOutbox(c, rec)

	c.processCommand(Command{ID: "term-1", Type: "terminal_data"})
	awaitHandoff(t, handedOff)
	if want := []string{"handoff:term-1"}; !slices.Equal(rec.get(), want) {
		t.Fatalf("order = %v, want %v (no outbox write)", rec.get(), want)
	}
	if n := len(c.resultChan); n != 1 {
		t.Fatalf("queued = %d, want 1", n)
	}
}

func TestDuplicateMarkerWhileDisconnectedIsNotPersisted(t *testing.T) {
	// A "duplicate" marker is not a terminal result (the server's schema
	// rejects it), so it never goes to the outbox; it keeps today's path.
	c := newTestClient("http://127.0.0.1:1", func(cmd Command) CommandResult {
		return CommandResult{Status: "duplicate"}
	})
	rec := &orderRecorder{}
	handedOff := wireOutbox(c, rec)

	c.processCommand(Command{ID: "cmd-d", Type: "run_script"})
	awaitHandoff(t, handedOff)
	if want := []string{"handoff:cmd-d"}; !slices.Equal(rec.get(), want) {
		t.Fatalf("order = %v, want %v", rec.get(), want)
	}
}

func TestResultWhileDisconnectedWithoutOutboxStillBuffers(t *testing.T) {
	// No outbox owner wired: keep today's buffering rather than drop.
	c := newTestClient("http://127.0.0.1:1", func(cmd Command) CommandResult {
		return CommandResult{Status: "completed"}
	})
	c.processCommand(Command{ID: "cmd-2", Type: "run_script"})
	if n := len(c.resultChan); n != 1 {
		t.Fatalf("queued = %d, want 1 (buffered for the next connection)", n)
	}
}

func TestSendResultWhileDisconnectedStillBuffers(t *testing.T) {
	// Direct SendResult callers (tunnel-closed, clipboard summary,
	// desktop-disconnect notices) keep today's buffering.
	c := newTestClient("http://127.0.0.1:1", noopHandler)
	rec := &orderRecorder{}
	wireOutbox(c, rec)
	if err := c.SendResult(CommandResult{Type: "command_result", CommandID: "n-1", Status: "completed"}); err != nil {
		t.Fatalf("SendResult = %v", err)
	}
	if n := len(c.resultChan); n != 1 {
		t.Fatalf("queued = %d, want 1", n)
	}
	if got := rec.get(); len(got) != 0 {
		t.Fatalf("outbox called for a direct SendResult: %v", got)
	}
}

func TestSendResultWhileConnectedStillUsesChannel(t *testing.T) {
	s := newScriptedWSServer(t, nil)
	c := newTestClient(s.srv.URL, func(cmd Command) CommandResult {
		return CommandResult{Status: "completed"}
	})
	rec := &orderRecorder{}
	handedOff := wireOutbox(c, rec)
	if err := c.connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(c.Stop)
	s.next(t)

	c.processCommand(Command{ID: "cmd-3", Type: "run_script"})
	awaitHandoff(t, handedOff)
	if want := []string{"handoff:cmd-3"}; !slices.Equal(rec.get(), want) {
		t.Fatalf("order = %v, want %v (no outbox while connected)", rec.get(), want)
	}
	if n := len(c.resultChan); n != 1 {
		t.Fatalf("queued = %d, want 1 (the pump would write it)", n)
	}
}
