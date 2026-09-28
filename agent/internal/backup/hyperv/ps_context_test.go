//go:build !windows

package hyperv

import (
	"context"
	"strings"
	"testing"
	"time"
)

// runCmdContext is the process runner under runPSContext (windows); it is
// exercised here with sleep(1) because powershell.exe only exists on Windows.

func TestRunCmdContext_TimeoutKillsTheProcess(t *testing.T) {
	start := time.Now()
	_, err := runCmdContext(context.Background(), 200*time.Millisecond, "sleep", "30")
	if err == nil {
		t.Fatal("a process outliving its timeout must fail")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("timeout not honoured: returned after %s", elapsed)
	}
	if !strings.Contains(err.Error(), "timed out after 200ms") {
		t.Fatalf("err = %v, want it to say the command timed out", err)
	}
}

func TestRunCmdContext_ParentCancelKillsTheProcess(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(200 * time.Millisecond); cancel() }()
	start := time.Now()
	_, err := runCmdContext(ctx, 10*time.Minute, "sleep", "30")
	if err == nil {
		t.Fatal("a cancelled context must stop the process")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Fatalf("cancellation not honoured: returned after %s", elapsed)
	}
	if !strings.Contains(err.Error(), "canceled") {
		t.Fatalf("err = %v, want it to report the cancellation", err)
	}
}

func TestRunCmdContext_AlreadyCancelledNeverStarts(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := runCmdContext(ctx, time.Minute, "sh", "-c", "echo ran"); err == nil {
		t.Fatal("an already-cancelled context must refuse to run")
	}
}

func TestRunCmdContext_ReturnsStdoutAndCombinedOutputOnFailure(t *testing.T) {
	out, err := runCmdContext(context.Background(), time.Minute, "sh", "-c", "echo hello")
	if err != nil || strings.TrimSpace(out) != "hello" {
		t.Fatalf("out = %q err = %v", out, err)
	}
	_, err = runCmdContext(context.Background(), time.Minute, "sh", "-c", "echo boom >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("err = %v, want the failing command's output", err)
	}
}
