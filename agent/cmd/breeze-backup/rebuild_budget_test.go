package main

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// withRebuildBudget swaps the package budget for one test.
func withRebuildBudget(t *testing.T, b rebuildBudget) {
	t.Helper()
	prev := bareMetalRebuildBudget
	bareMetalRebuildBudget = b
	t.Cleanup(func() { bareMetalRebuildBudget = prev })
}

// scriptedRebuild answers the dry run with a plan and hands the real run to
// real, which plays the engine: it reports progress through opts.Progress
// and returns the way rebuild.Run does when its context is cut.
func scriptedRebuild(real func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error)) func(context.Context, rebuild.Options) (*rebuild.Result, error) {
	return func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		if opts.DryRun {
			return &rebuild.Result{Status: "completed", Plan: &rebuild.Plan{}}, nil
		}
		return real(ctx, opts)
	}
}

// engineFailure is what rebuild.Run returns when a phase fails on ctx.
func engineFailure(ph rebuild.Phase, err error) (*rebuild.Result, error) {
	wrapped := errors.New(string(ph) + ": " + err.Error())
	return &rebuild.Result{Status: "failed", PhaseReached: ph, Error: wrapped.Error()}, wrapped
}

// runExecWithGuard runs execBareMetalRebuild and fails the test if it does
// not return within limit (the pre-#6664 code would block for 4 h).
func runExecWithGuard(t *testing.T, ctx context.Context, server string, fn func(context.Context, rebuild.Options) (*rebuild.Result, error), limit time.Duration) backupipc.BackupCommandResult {
	t.Helper()
	done := make(chan backupipc.BackupCommandResult, 1)
	go func() { done <- execBareMetalRebuild(ctx, testBareMetalRebuildPayload(t, server), fn) }()
	select {
	case res := <-done:
		return res
	case <-time.After(limit):
		t.Fatalf("execBareMetalRebuild did not return within %s", limit)
		return backupipc.BackupCommandResult{}
	}
}

func fastBudget() rebuildBudget {
	return rebuildBudget{
		Ceiling: time.Minute,
		// Absolute slack of hundreds of ms per check: -race on a loaded CI
		// host can delay a wakeup by that much.
		StallWindow:          500 * time.Millisecond,
		OpaqueStallFloor:     2 * time.Second,
		OpaqueBytesPerSecond: 1 << 20,
		Tick:                 25 * time.Millisecond,
	}
}

// The production budget must not re-create the fixed 4 h cap (#6664: a
// 130k-file restore needs longer), must fit inside the agent's IPC wait so
// the helper's own terminal result is what reaches the server, and must be
// strictly shorter than the server's 24 h whole-machine-restore reaper.
func TestBareMetalRebuildBudget_ProductionValues(t *testing.T) {
	b := bareMetalRebuildBudget
	if b.Ceiling <= 4*time.Hour {
		t.Errorf("ceiling = %s, want well above the old fixed 4h", b.Ceiling)
	}
	if b.Ceiling != backupipc.BareMetalRebuildRunBudget {
		t.Errorf("ceiling = %s, want backupipc.BareMetalRebuildRunBudget (%s) so the forwarder and helper agree", b.Ceiling, backupipc.BareMetalRebuildRunBudget)
	}
	if backupipc.BareMetalRebuildForwardTimeout <= b.Ceiling {
		t.Errorf("forward timeout %s must exceed the helper ceiling %s", backupipc.BareMetalRebuildForwardTimeout, b.Ceiling)
	}
	if backupipc.BareMetalRebuildForwardTimeout >= 24*time.Hour {
		t.Errorf("forward timeout %s must stay under the server's 24h WHOLE_MACHINE_RESTORE_TIMEOUT_MS", backupipc.BareMetalRebuildForwardTimeout)
	}
	if b.StallWindow <= 0 || b.OpaqueStallFloor < b.StallWindow || b.OpaqueBytesPerSecond <= 0 || b.Tick <= 0 || b.Tick >= b.StallWindow {
		t.Errorf("inconsistent budget: %+v", b)
	}
}

// Red on the old code: the engine saw a 4 h deadline.
func TestExecBareMetalRebuild_DeadlineIsTheCeilingNotFourHours(t *testing.T) {
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	var remaining time.Duration
	var hasDeadline bool
	fn := scriptedRebuild(func(ctx context.Context, _ rebuild.Options) (*rebuild.Result, error) {
		var dl time.Time
		if dl, hasDeadline = ctx.Deadline(); hasDeadline {
			remaining = time.Until(dl)
		}
		return &rebuild.Result{Status: "completed"}, nil
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if !res.Success {
		t.Fatalf("res = %+v", res)
	}
	// The ceiling is enforced by the watchdog (so it can name the phase);
	// any context deadline the engine sees must not be shorter than it.
	if hasDeadline && remaining < bareMetalRebuildBudget.Ceiling-time.Minute {
		t.Fatalf("engine deadline %s away, want none shorter than the %s ceiling", remaining, bareMetalRebuildBudget.Ceiling)
	}
}

func TestExecBareMetalRebuild_StalledEngineIsStoppedWithDistinctReason(t *testing.T) {
	withRebuildBudget(t, fastBudget())
	server, statuses, reasons := newTokenModeTestServerRecordingReasons(t, biosLayoutJSON(t), "new", "")
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		opts.Progress(rebuild.PhaseRestore, "restored: /etc/hosts", 1, 130000)
		<-ctx.Done() // a hung per-file download: no bytes, no progress
		return engineFailure(rebuild.PhaseRestore, ctx.Err())
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if res.Success {
		t.Fatalf("a stalled rebuild must fail: %+v", res)
	}
	if !strings.Contains(res.Stderr, "stalled") || !strings.Contains(res.Stderr, "restore") {
		t.Fatalf("stderr = %q, want a stall reason naming the phase", res.Stderr)
	}
	if !strings.Contains(res.Stderr, "context canceled") {
		t.Errorf("stderr = %q, want the engine's own error kept after the budget reason", res.Stderr)
	}
	// The terminal progress post must reach the server even though the
	// run's context is already cancelled.
	st, rs := statuses(), reasons()
	if len(st) == 0 || st[len(st)-1] != "failed" || !strings.Contains(rs[len(rs)-1], "stalled") {
		t.Fatalf("posted statuses=%v reasons=%q, want a final failed post carrying the stall reason", st, rs)
	}
}

func TestExecBareMetalRebuild_SteadyProgressOutlivesTheStallWindow(t *testing.T) {
	b := fastBudget()
	withRebuildBudget(t, b)
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		deadline := time.Now().Add(3 * b.StallWindow)
		for i := int64(1); time.Now().Before(deadline); i++ {
			if ctx.Err() != nil {
				return engineFailure(rebuild.PhaseRestore, ctx.Err())
			}
			opts.Progress(rebuild.PhaseRestore, "restored: f", i, 1<<20)
			time.Sleep(b.StallWindow / 10)
		}
		return &rebuild.Result{Status: "completed"}, nil
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if !res.Success {
		t.Fatalf("a restore that keeps making progress must not be stopped: %+v", res)
	}
}

// One large file: no per-file progress for longer than the stall window,
// but its body bytes keep landing through the download-progress hook.
func TestExecBareMetalRebuild_DownloadBytesCountAsProgress(t *testing.T) {
	b := fastBudget()
	withRebuildBudget(t, b)
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		opts.Progress(rebuild.PhaseRestore, "starting", 0, 0)
		w := providers.DownloadProgressWriter(ctx, io.Discard)
		deadline := time.Now().Add(3 * b.StallWindow)
		for time.Now().Before(deadline) {
			if ctx.Err() != nil {
				return engineFailure(rebuild.PhaseRestore, ctx.Err())
			}
			_, _ = w.Write(make([]byte, 32<<10))
			time.Sleep(b.StallWindow / 10)
		}
		return &rebuild.Result{Status: "completed"}, nil
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if !res.Success {
		t.Fatalf("download bytes must count as progress: %+v", res)
	}
}

// Phases with no progress stream (convert, boot, ...) get the longer
// opaque window, not the streaming one.
func TestExecBareMetalRebuild_OpaquePhaseGetsTheLongerWindow(t *testing.T) {
	b := fastBudget()
	withRebuildBudget(t, b)
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		opts.Progress(rebuild.PhaseConvert, "converting", 0, 1)
		select {
		case <-ctx.Done():
			return engineFailure(rebuild.PhaseConvert, ctx.Err())
		case <-time.After(2 * b.StallWindow): // 1s: twice the streaming window, half the opaque floor
		}
		return &rebuild.Result{Status: "completed"}, nil
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if !res.Success {
		t.Fatalf("an opaque phase inside its window must not be stopped: %+v", res)
	}
}

func TestExecBareMetalRebuild_HungOpaquePhaseIsStopped(t *testing.T) {
	withRebuildBudget(t, fastBudget())
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		opts.Progress(rebuild.PhaseBoot, "starting", 0, 0)
		<-ctx.Done()
		return engineFailure(rebuild.PhaseBoot, ctx.Err())
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if res.Success || !strings.Contains(res.Stderr, "stalled") || !strings.Contains(res.Stderr, "boot") {
		t.Fatalf("res = %+v, want a stall failure in boot", res)
	}
}

func TestExecBareMetalRebuild_CeilingIsADistinctReason(t *testing.T) {
	b := fastBudget()
	b.Ceiling = time.Second
	withRebuildBudget(t, b)
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		for i := int64(1); ; i++ {
			if ctx.Err() != nil {
				return engineFailure(rebuild.PhaseRestore, ctx.Err())
			}
			opts.Progress(rebuild.PhaseRestore, "restored: f", i, 1<<20)
			time.Sleep(10 * time.Millisecond)
		}
	})
	res := runExecWithGuard(t, context.Background(), server.URL, fn, 10*time.Second)
	if res.Success || !strings.Contains(res.Stderr, "time budget") {
		t.Fatalf("res = %+v, want the time-budget reason", res)
	}
	if strings.Contains(res.Stderr, "stalled") {
		t.Fatalf("stderr = %q: a progressing run is over budget, not stalled", res.Stderr)
	}
}

// A stop/cancel from the agent is not a budget failure and must not be
// reported as one.
func TestExecBareMetalRebuild_ParentCancelIsNotABudgetFailure(t *testing.T) {
	withRebuildBudget(t, fastBudget())
	server, _ := newTokenModeTestServer(t, biosLayoutJSON(t))
	parent, cancel := context.WithCancel(context.Background())
	fn := scriptedRebuild(func(ctx context.Context, opts rebuild.Options) (*rebuild.Result, error) {
		opts.Progress(rebuild.PhaseRestore, "restored: f", 1, 2)
		cancel()
		<-ctx.Done()
		return engineFailure(rebuild.PhaseRestore, ctx.Err())
	})
	res := runExecWithGuard(t, parent, server.URL, fn, 10*time.Second)
	if res.Success || strings.Contains(res.Stderr, "stalled") || strings.Contains(res.Stderr, "time budget") {
		t.Fatalf("res = %+v, want a plain cancellation failure", res)
	}
}

func TestRebuildStallWindow(t *testing.T) {
	b := rebuildBudget{
		Ceiling:              20 * time.Hour,
		StallWindow:          30 * time.Minute,
		OpaqueStallFloor:     2 * time.Hour,
		OpaqueBytesPerSecond: 25 << 20,
	}
	cases := []struct {
		name  string
		phase rebuild.Phase
		bytes int64
		want  time.Duration
	}{
		{"before any phase", "", 0, 30 * time.Minute},
		{"preflight streams", rebuild.PhasePreflight, 1 << 40, 30 * time.Minute},
		{"restore streams", rebuild.PhaseRestore, 1 << 40, 30 * time.Minute},
		{"small opaque phase gets the floor", rebuild.PhaseConvert, 10 << 30, 2 * time.Hour},
		// 360 GiB at 25 MiB/s = 14745.6 s ≈ 4h05m
		{"large restore scales the opaque window", rebuild.PhaseConvert, 360 << 30, time.Duration(float64(360<<30) / float64(25<<20) * float64(time.Second))},
		{"never past the ceiling", rebuild.PhaseBoot, 1 << 50, 20 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := b.stallWindowFor(tc.phase, tc.bytes); got != tc.want {
				t.Fatalf("stallWindowFor(%q, %d) = %s, want %s", tc.phase, tc.bytes, got, tc.want)
			}
		})
	}
}
