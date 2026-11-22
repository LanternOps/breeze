//go:build !windows

package systemstate

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestCollectorCommand_DeadlineKillsTheSubprocess(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	var err error
	returnsWithin(t, 10*time.Second, func() {
		_, err = collectorCommand(ctx, "sleep", "300").Output()
	})
	if err == nil {
		t.Fatal("expected the killed subprocess to report an error")
	}
}

// exec.CommandContext kills only the direct child. A grandchild holding the
// stdout pipe would keep Output() blocked until it exited, deadline or not.
func TestCollectorCommand_GrandchildHoldingStdoutCannotOutliveTheDeadline(t *testing.T) {
	origDelay := commandWaitDelay
	t.Cleanup(func() { commandWaitDelay = origDelay })
	commandWaitDelay = 100 * time.Millisecond

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()

	returnsWithin(t, 10*time.Second, func() {
		_, _ = collectorCommand(ctx, "sh", "-c", "sleep 300 & wait").Output()
	})
}

// A tool that prompts must read EOF rather than wait for an answer nobody gives.
func TestCollectorCommand_StdinIsClosed(t *testing.T) {
	var out []byte
	var err error
	returnsWithin(t, 10*time.Second, func() {
		out, err = collectorCommand(context.Background(), "sh", "-c", "read answer; echo got:$answer").Output()
	})
	// read returns non-zero at EOF, which does not stop the echo.
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "got:" {
		t.Errorf("output = %q, want an empty answer from a closed stdin", got)
	}
}
