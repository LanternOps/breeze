package websocket

import (
	"fmt"
	"sync"
	"testing"
)

// #8296: a long command (install_patches mid-WUA) that finishes while the
// agent is shutting down produced its result AFTER the websocket client had
// been stopped. processCommand only logged the "client is stopped" refusal, so
// the terminal result was dropped and the server row sat in `sent` until the
// reaper. The refused result must reach the on-disk outbox instead.
func TestProcessCommand_ResultAfterStopGoesToOutbox(t *testing.T) {
	c := newTestClient("http://localhost", func(cmd Command) CommandResult {
		return CommandResult{Status: "failed", ExitCode: 1, Error: "install failed"}
	})

	var mu sync.Mutex
	var order []string
	var preserved []CommandResult
	c.OnResultWriteFailed = func(r CommandResult) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, "preserved")
		preserved = append(preserved, r)
	}
	c.OnResultHandedOff = func(r CommandResult) {
		mu.Lock()
		defer mu.Unlock()
		order = append(order, "handedOff:"+r.CommandID)
	}

	c.Stop()
	c.processCommand(Command{ID: "cmd-late", Type: "install_patches"})

	mu.Lock()
	defer mu.Unlock()
	if len(preserved) != 1 {
		t.Fatalf("result refused by a stopped client was not handed to the outbox: %+v", preserved)
	}
	got := preserved[0]
	if got.CommandID != "cmd-late" || got.Type != "command_result" || got.Status != "failed" || got.Error != "install failed" {
		t.Fatalf("outboxed result lost its identity or terminal status: %+v", got)
	}
	// The hand-off notice must come AFTER the result is persisted: the
	// heartbeat clears the in-flight journal entry on it, and clearing first
	// would reopen the very loss window the journal exists to close.
	if len(order) != 2 || order[0] != "preserved" || order[1] != "handedOff:cmd-late" {
		t.Fatalf("callback order = %v, want [preserved handedOff:cmd-late]", order)
	}
}

// A result accepted into resultChan before Stop is never written once the
// pumps exit — and the process is about to exit with it. Stop must hand every
// buffered result to the outbox.
func TestStop_DrainsBufferedResultsToOutbox(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler) // never connected: no pump drains
	var mu sync.Mutex
	var preserved []string
	c.OnResultWriteFailed = func(r CommandResult) {
		mu.Lock()
		defer mu.Unlock()
		preserved = append(preserved, r.CommandID)
	}

	for _, id := range []string{"cmd-a", "cmd-b"} {
		if err := c.SendResult(CommandResult{Type: "command_result", CommandID: id, Status: "completed"}); err != nil {
			t.Fatalf("SendResult(%s): %v", id, err)
		}
	}
	c.Stop()

	mu.Lock()
	defer mu.Unlock()
	if len(preserved) != 2 || preserved[0] != "cmd-a" || preserved[1] != "cmd-b" {
		t.Fatalf("Stop preserved %v, want [cmd-a cmd-b]", preserved)
	}
	if n := len(c.resultChan); n != 0 {
		t.Fatalf("resultChan still holds %d results after Stop", n)
	}
}

// A successful hand-off (accepted into resultChan) also fires the notice, so
// the journal entry for a normally-delivered command is cleared.
func TestProcessCommand_HandedOffOnSuccessfulQueue(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	handed := make(chan string, 1)
	c.OnResultWriteFailed = func(CommandResult) { t.Error("queued result must not be outboxed") }
	c.OnResultHandedOff = func(r CommandResult) { handed <- r.CommandID }

	c.processCommand(Command{ID: "cmd-ok", Type: "list_processes"})

	select {
	case id := <-handed:
		if id != "cmd-ok" {
			t.Fatalf("handed off %q, want cmd-ok", id)
		}
	default:
		t.Fatal("OnResultHandedOff not invoked for a queued result")
	}
	if len(c.resultChan) != 1 {
		t.Fatalf("resultChan holds %d, want 1", len(c.resultChan))
	}
}

// SendResult racing Stop: every result SendResult ACCEPTED must reach the
// outbox through Stop's drain (nothing else drains a never-connected client).
// Without stopMu, an enqueue landing after the drain is reported as success
// and then lost with the process.
func TestSendResult_RacingStopLosesNothing(t *testing.T) {
	for iter := 0; iter < 200; iter++ {
		c := newTestClient("http://localhost", noopHandler)
		var mu sync.Mutex
		preserved := map[string]bool{}
		c.OnResultWriteFailed = func(r CommandResult) {
			mu.Lock()
			defer mu.Unlock()
			preserved[r.CommandID] = true
		}

		const senders = 8
		accepted := make(chan string, senders)
		var wg sync.WaitGroup
		start := make(chan struct{})
		for i := 0; i < senders; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				id := fmt.Sprintf("cmd-%d-%d", iter, i)
				if c.SendResult(CommandResult{Type: "command_result", CommandID: id, Status: "completed"}) == nil {
					accepted <- id
				}
			}(i)
		}
		close(start)
		c.Stop()
		wg.Wait()
		close(accepted)

		mu.Lock()
		for id := range accepted {
			if !preserved[id] {
				mu.Unlock()
				t.Fatalf("iteration %d: %s was accepted by SendResult but never reached the outbox", iter, id)
			}
		}
		mu.Unlock()
		if n := len(c.resultChan); n != 0 {
			t.Fatalf("iteration %d: %d results stranded in resultChan after Stop", iter, n)
		}
	}
}
