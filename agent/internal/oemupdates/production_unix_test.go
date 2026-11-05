//go:build !windows

package oemupdates

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestProcExecReportsTheExitCode(t *testing.T) {
	res, err := procExec{}.Run(context.Background(), ExecSpec{Path: "/bin/sh", Args: []string{"-c", "exit 3"}})
	if err != nil || res.ExitCode != 3 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestProcExecKilledByContextReportsTheContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := procExec{}.Run(ctx, ExecSpec{Path: "/bin/sleep", Args: []string{"5"}})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the deadline", err)
	}
}

// A process that finished on its own keeps its exit code even when the
// context ended just after: its result is real.
func TestProcExecKeepsAnExitThatBeatTheContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	res, err := procExec{onExit: cancel}.Run(ctx, ExecSpec{Path: "/bin/sh", Args: []string{"-c", "exit 1"}})
	if err != nil || res.ExitCode != 1 {
		t.Fatalf("res=%+v err=%v", res, err)
	}
}

func TestProcExecRefusesAnEmptyPath(t *testing.T) {
	if _, err := (procExec{}).Run(context.Background(), ExecSpec{}); err == nil {
		t.Fatal("ran an empty path")
	}
}
