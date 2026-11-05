package oemupdates

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestFlashRecordsPendingVerificationBeforeItStarts(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		// If the machine dies here, the next start must still verify.
		pending, err := readPendingVerifications(f.store)
		if err != nil || len(pending) != 1 || pending[0].CommandID != testCommandID {
			t.Errorf("pending during the flash = %+v, %v", pending, err)
		}
		if m, ok := ReadInterruptedMarker(f.store); !ok || !m.FlashStarted {
			t.Errorf("marker during the flash = %+v", m)
		}
		return RunResult{Lane: LaneDell, Outcome: OutcomeSuccess}, nil
	}
	f.run()
}

func TestNoUpdatesClearsPendingVerification(t *testing.T) {
	f := newRunFixture(t)
	f.lane.apply = func(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error) {
		return RunResult{Lane: LaneDell, Outcome: OutcomeNoUpdates}, nil
	}
	f.run()
	if pending, _ := readPendingVerifications(f.store); len(pending) != 0 {
		t.Fatalf("pending = %+v; nothing was flashed", pending)
	}
}

func TestDriverRunKeepsAnEarlierPendingVerification(t *testing.T) {
	f := newRunFixture(t)
	const earlier = "11111111-2222-4333-8444-555555555555"
	_ = addPendingVerification(f.store, PendingVerification{CommandID: earlier, VerifyAfter: f.clock.Now()})
	f.req.Categories = []string{CategoryDriver}
	f.run()
	pending, _ := readPendingVerifications(f.store)
	if len(pending) != 1 || pending[0].CommandID != earlier {
		t.Fatalf("pending = %+v", pending)
	}
}

func TestFlashMarkerWriteIsMandatory(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Preflight = func() error {
		f.store.failWrite = errors.New("disk full") // the start marker got out; later writes fail
		return nil
	}
	r := f.run()
	if r.Outcome != OutcomeFailed || errCode(r) != "marker_unwritable" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
	if _, active := f.guard.Active(); active {
		t.Fatal("the guard section was left open")
	}
}

func TestFlashRefusedWhenAgentStopsBeforeIt(t *testing.T) {
	f := newRunFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	f.deps.Preflight = func() error { cancel(); return nil }
	r := Run(ctx, f.req, f.lane, f.deps)
	if r.Outcome != OutcomeInterrupted || errCode(r) != "agent_stopping" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestFlashRefusedWhenNotAfterPassesBeforeIt(t *testing.T) {
	f := newRunFixture(t)
	f.deps.Preflight = func() error { f.clock.Set(f.req.NotAfter.Add(time.Minute)); return nil }
	r := f.run()
	if r.Outcome != OutcomeRetryLater || errCode(r) != "not_after_passed" || len(f.lane.Applied()) != 0 {
		t.Fatalf("result = %+v", r)
	}
}

func TestToolInstallHonoursTheRunDeadline(t *testing.T) {
	f := newRunFixture(t)
	f.lane.setTool(ToolState{})
	f.lane.onInstall = &ToolState{Present: true, Path: dcuPath, Version: "5.7.2"}
	f.req.Tool = toolSpec()
	var sawDeadline bool
	f.deps.Exec = installingExec(f.lane, func(ctx context.Context, spec ExecSpec) (ExecResult, error) {
		if spec.Args[0] == "/s" {
			_, sawDeadline = ctx.Deadline()
		}
		return ExecResult{}, nil
	})
	f.req.Categories = []string{CategoryDriver}
	f.run()
	if !sawDeadline {
		t.Fatal("the tool install ran without the run deadline")
	}
}
