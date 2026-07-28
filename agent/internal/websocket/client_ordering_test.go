package websocket

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Issue #2870: terminal_data commands are raw PTY input. Dispatching each one
// on its own goroutine let the scheduler reorder back-to-back keystrokes and
// scramble the shell input. These tests pin the fix: order-sensitive commands
// are serialized through a single ordered lane, while everything else keeps
// concurrent dispatch.

func TestIsOrderedCommand(t *testing.T) {
	tests := []struct {
		cmdType string
		want    bool
	}{
		{"terminal_start", true},
		{"terminal_data", true},
		{"terminal_resize", true},
		{"terminal_stop", true},
		{"run_script", false},
		{"list_processes", false},
		{"start_desktop", false},
		{"tunnel_data", false}, // tunnel bytes ride binary frames, not commands
		{"", false},
	}
	for _, tt := range tests {
		if got := isOrderedCommand(tt.cmdType); got != tt.want {
			t.Errorf("isOrderedCommand(%q) = %v, want %v", tt.cmdType, got, tt.want)
		}
	}
}

// TestOrderedCommandsExecuteInOrderSerially proves the #2870 fix: a burst of
// terminal_data commands dispatched back-to-back (as the read pump does when
// TCP delivers several frames at once) is executed strictly in arrival order,
// one at a time. Under the old `go processCommand(cmd)` dispatch this test
// fails: the per-command goroutines race and the recorded order shuffles.
func TestOrderedCommandsExecuteInOrderSerially(t *testing.T) {
	const n = 200

	var mu sync.Mutex
	var got []string
	var inFlight atomic.Int32
	var maxInFlight atomic.Int32
	done := make(chan struct{})

	c := New(&Config{}, func(cmd Command) CommandResult {
		cur := inFlight.Add(1)
		for {
			prev := maxInFlight.Load()
			if cur <= prev || maxInFlight.CompareAndSwap(prev, cur) {
				break
			}
		}
		// Yield to the scheduler so racing goroutines (the old dispatch
		// shape) would actually interleave here instead of passing by luck.
		time.Sleep(time.Microsecond)
		mu.Lock()
		got = append(got, cmd.ID)
		if len(got) == n {
			close(done)
		}
		mu.Unlock()
		inFlight.Add(-1)
		return CommandResult{CommandID: cmd.ID, Status: "completed"}
	})
	defer c.Stop()

	want := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id := fmt.Sprintf("term-data-%d", i)
		want = append(want, id)
		c.dispatchCommand(Command{ID: id, Type: "terminal_data", Payload: map[string]any{}})
	}

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for ordered commands to execute")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(got) != n {
		t.Fatalf("executed %d commands, want %d", len(got), n)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("execution order diverged at index %d: got %s, want %s\nfull order: %v", i, got[i], want[i], got)
		}
	}
	if m := maxInFlight.Load(); m != 1 {
		t.Fatalf("ordered commands overlapped: max in-flight = %d, want 1", m)
	}
}

// TestOrderedLanePreservesLifecycleOrdering: terminal_start, a burst of
// terminal_data, then terminal_stop must execute in exactly that order — data
// can never overtake the start that creates the PTY session or trail the stop
// that destroys it.
func TestOrderedLanePreservesLifecycleOrdering(t *testing.T) {
	var mu sync.Mutex
	var got []string
	done := make(chan struct{})
	const total = 12

	c := New(&Config{}, func(cmd Command) CommandResult {
		mu.Lock()
		got = append(got, cmd.ID)
		if len(got) == total {
			close(done)
		}
		mu.Unlock()
		return CommandResult{CommandID: cmd.ID, Status: "completed"}
	})
	defer c.Stop()

	want := make([]string, 0, total)
	dispatch := func(id, cmdType string) {
		want = append(want, id)
		c.dispatchCommand(Command{ID: id, Type: cmdType})
	}

	dispatch("start-1", "terminal_start")
	for i := 0; i < total-2; i++ {
		dispatch(fmt.Sprintf("data-%d", i), "terminal_data")
	}
	dispatch("stop-1", "terminal_stop")

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for lifecycle commands to execute")
	}

	mu.Lock()
	defer mu.Unlock()
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("lifecycle order diverged at index %d: got %s, want %s\nfull order: %v", i, got[i], want[i], got)
		}
	}
}

// TestNonOrderedCommandsRemainConcurrent guards the other half of the
// dispatch contract: regular commands still run on independent goroutines. A
// long-running command (run_script can hold a worker for up to an hour) must
// not head-of-line-block an unrelated command. If dispatchCommand serialized
// everything, the first handler would block forever waiting for the second
// and this test would time out.
func TestNonOrderedCommandsRemainConcurrent(t *testing.T) {
	secondRan := make(chan struct{})
	firstDone := make(chan struct{})

	c := New(&Config{}, func(cmd Command) CommandResult {
		switch cmd.ID {
		case "blocker":
			select {
			case <-secondRan:
			case <-time.After(10 * time.Second):
				t.Error("blocker never observed the second command running — dispatch is serialized")
			}
			close(firstDone)
		case "second":
			close(secondRan)
		}
		return CommandResult{CommandID: cmd.ID, Status: "completed"}
	})
	defer c.Stop()

	c.dispatchCommand(Command{ID: "blocker", Type: "run_script"})
	c.dispatchCommand(Command{ID: "second", Type: "list_processes"})

	select {
	case <-firstDone:
	case <-time.After(15 * time.Second):
		t.Fatal("timed out: non-ordered commands did not run concurrently")
	}
}

// TestOrderedDispatchDoesNotWedgeAfterStop: once the client is stopped, an
// ordered dispatch with a full lane must return promptly (the <-c.done arm)
// instead of blocking the read pump forever.
func TestOrderedDispatchDoesNotWedgeAfterStop(t *testing.T) {
	c := New(&Config{}, func(cmd Command) CommandResult {
		return CommandResult{CommandID: cmd.ID, Status: "completed"}
	})
	// Shrink the lane and pre-fill it so the send arm can never proceed, then
	// stop the client WITHOUT ever starting the pump (orderedPumpOnce is
	// burned first so dispatchCommand won't start a consumer that drains it).
	c.orderedPumpOnce.Do(func() {})
	c.orderedCmdChan = make(chan Command, 1)
	c.orderedCmdChan <- Command{ID: "filler", Type: "terminal_data"}
	c.Stop()

	returned := make(chan struct{})
	go func() {
		c.dispatchCommand(Command{ID: "after-stop", Type: "terminal_data"})
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("dispatchCommand wedged on a stopped client with a full ordered lane")
	}
}
