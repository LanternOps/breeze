package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/rebuild"
	"github.com/breeze-rmm/agent/internal/backupipc"
)

// rebuildBudget bounds one server-driven bare_metal_rebuild (#6664).
//
// A fixed deadline cannot fit every restore: 4 h aborted a DR rehearsal of
// a normal system disk (about 9 files/s, so anything past about 130k files).
// The helper instead stops a rebuild that stops making progress, and keeps
// an absolute ceiling only as a backstop:
//
//   - Streaming phases (preflight, restore) report progress per file, and
//     every body chunk of a recovery download counts too (the provider's
//     download-progress hook), so one large file is not a stall. They are
//     stopped after StallWindow with no progress. The window covers the
//     recovery provider's retry backoff (about 5 min) with room to spare.
//   - The other phases run external tools that report nothing while they
//     work (qemu-img convert, mkfs, bootloader and initramfs tools, DISM).
//     They get OpaqueStallFloor, or longer when the restore was large: the
//     restored bytes at OpaqueBytesPerSecond, since a VHDX convert reads
//     every allocated byte.
//   - Ceiling stops even a progressing run, below the agent's IPC wait
//     (backupipc.BareMetalRebuildForwardTimeout), so the server records the
//     helper's own result rather than a timeout.
type rebuildBudget struct {
	Ceiling              time.Duration
	StallWindow          time.Duration
	OpaqueStallFloor     time.Duration
	OpaqueBytesPerSecond int64
	// Tick is how often the watchdog checks; it only sets how late after
	// the window a stall is noticed.
	Tick time.Duration
}

// bareMetalRebuildBudget is a var so tests can shrink it.
var bareMetalRebuildBudget = rebuildBudget{
	Ceiling:              backupipc.BareMetalRebuildRunBudget,
	StallWindow:          30 * time.Minute,
	OpaqueStallFloor:     2 * time.Hour,
	OpaqueBytesPerSecond: 25 << 20, // 25 MiB/s: a slow disk, well under any real qemu-img convert
	Tick:                 time.Minute,
}

// stallWindowFor is how long phase may go without progress, given the bytes
// downloaded so far in this rebuild.
func (b rebuildBudget) stallWindowFor(phase rebuild.Phase, downloadedBytes int64) time.Duration {
	switch phase {
	case "", rebuild.PhasePreflight, rebuild.PhaseRestore:
		return b.StallWindow
	}
	w := b.OpaqueStallFloor
	if b.OpaqueBytesPerSecond > 0 && downloadedBytes > 0 {
		if scaled := time.Duration(float64(downloadedBytes) / float64(b.OpaqueBytesPerSecond) * float64(time.Second)); scaled > w {
			w = scaled
		}
	}
	if b.Ceiling > 0 && w > b.Ceiling {
		w = b.Ceiling
	}
	return w
}

// rebuildBudgetError is the cancellation cause when the watchdog stops a
// rebuild, so the failure reads as "stalled" or "over budget" rather than a
// per-file "context canceled".
type rebuildBudgetError struct {
	Stalled bool // false: the absolute ceiling
	Phase   rebuild.Phase
	Idle    time.Duration
	Limit   time.Duration
}

func (e *rebuildBudgetError) Error() string {
	phase := string(e.Phase)
	if phase == "" {
		phase = "startup"
	}
	if e.Stalled {
		return fmt.Sprintf("rebuild stalled: no progress for %s in phase %s (limit %s)", e.Idle.Round(time.Second), phase, e.Limit)
	}
	return fmt.Sprintf("rebuild exceeded its time budget of %s (in phase %s)", e.Limit, phase)
}

// rebuildWatchdog tracks the last progress of one rebuild and cancels its
// context when the budget runs out.
type rebuildWatchdog struct {
	budget rebuildBudget
	cancel context.CancelCauseFunc

	mu    sync.Mutex
	phase rebuild.Phase
	last  time.Time
	bytes int64
}

// startRebuildWatchdog derives the rebuild context from parent. The returned
// context carries a download-progress callback (providers.WithDownloadProgress)
// so a recovery provider built from it reports body bytes to the watchdog.
// stop must be called when the rebuild returns.
func startRebuildWatchdog(parent context.Context, b rebuildBudget) (ctx context.Context, w *rebuildWatchdog, stop func()) {
	inner, cancel := context.WithCancelCause(parent)
	w = &rebuildWatchdog{budget: b, cancel: cancel, last: time.Now()}
	done := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		w.watch(inner, done)
	}()
	stop = func() {
		close(done)
		wg.Wait()
		cancel(nil)
	}
	return providers.WithDownloadProgress(inner, w.downloaded), w, stop
}

func (w *rebuildWatchdog) watch(ctx context.Context, done <-chan struct{}) {
	ceiling := time.NewTimer(w.budget.Ceiling)
	defer ceiling.Stop()
	tick := time.NewTicker(w.budget.Tick)
	defer tick.Stop()
	for {
		select {
		case <-done:
			return
		case <-ctx.Done():
			return
		case <-ceiling.C:
			w.mu.Lock()
			phase := w.phase
			w.mu.Unlock()
			w.cancel(&rebuildBudgetError{Phase: phase, Limit: w.budget.Ceiling})
			return
		case now := <-tick.C:
			w.mu.Lock()
			phase, idle, limit := w.phase, now.Sub(w.last), w.budget.stallWindowFor(w.phase, w.bytes)
			w.mu.Unlock()
			if idle > limit {
				w.cancel(&rebuildBudgetError{Stalled: true, Phase: phase, Idle: idle, Limit: limit})
				return
			}
		}
	}
}

// progress records an engine progress report (rebuild.Options.Progress).
func (w *rebuildWatchdog) progress(phase rebuild.Phase) {
	w.mu.Lock()
	w.phase, w.last = phase, time.Now()
	w.mu.Unlock()
}

// downloaded records download body bytes; it may be called concurrently.
func (w *rebuildWatchdog) downloaded(n int64) {
	w.mu.Lock()
	w.bytes += n
	w.last = time.Now()
	w.mu.Unlock()
}

// annotateBudgetFailure puts the watchdog's reason in front of a failed
// run's error when the watchdog is why the run stopped, keeping the
// engine's own error after it. The result's Error gets the same text so the
// terminal progress post and the command result agree. A refusal, a
// success, or any other failure is returned unchanged.
func annotateBudgetFailure(ctx context.Context, res *rebuild.Result, runErr error) (*rebuild.Result, error) {
	if runErr == nil || (res != nil && res.Status == "refused") {
		return res, runErr
	}
	var budgetErr *rebuildBudgetError
	if !errors.As(context.Cause(ctx), &budgetErr) {
		return res, runErr
	}
	if errors.As(runErr, new(*rebuildBudgetError)) {
		return res, runErr // the engine already carries the cause
	}
	detail := runErr.Error()
	if res != nil && res.Error != "" {
		detail = res.Error
	}
	annotated := fmt.Errorf("%w: %s", budgetErr, detail)
	if res != nil {
		res.Error = annotated.Error()
	}
	return res, annotated
}
