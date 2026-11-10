package systemstate

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

// ---------------------------------------------------------------------------
// Deadlines on system-state collection (#11201)
//
// Collection copies live trees (/etc, /Library/Preferences), spawns OS tools
// and reads /proc, /sys and shadow copies, all on hosts we do not control.
// None of that may hold a backup up indefinitely: a step that outlasts its
// deadline loses whatever it had not yet captured, is named in the manifest's
// IncompleteSteps
// (which the run turns into a job warning) and the next step runs.
//
// Two layers do this, because neither is enough alone:
//
//   - ctx reaches every subprocess (collectorCommand kills it) and every copy
//     loop (contextReader stops it between reads), so a step normally stops
//     promptly and cleans up after itself.
//   - runBounded stops WAITING for a step that ignores ctx, because a read of
//     a dead mount sits in the kernel and cannot be cancelled. Same shape as
//     FlushRegistryHives, and the same cost: the goroutine stays parked until
//     its syscall returns. Once it does, the ctx checks in copyFile/copyTree
//     keep it from staging anything more.
// ---------------------------------------------------------------------------

var (
	// stepTimeout bounds one collection step. A healthy step takes seconds;
	// the slowest real one is the Windows registry step, whose own snapshot
	// (snapshotVolumeTimeout, 3 min) and flush (flushTimeout, 60 s) fit well
	// inside this.
	stepTimeout = 10 * time.Minute

	// collectionTimeout bounds a whole collection, so a host where every step
	// is wedged costs a run this much rather than steps × stepTimeout.
	collectionTimeout = 30 * time.Minute

	// versionTimeout bounds the OS version probe that runs before the steps.
	versionTimeout = 30 * time.Second

	// abandonGrace is how long runBounded waits, once a deadline passes, for a
	// step to notice ctx and return what it captured before leaving it behind.
	abandonGrace = 5 * time.Second

	// commandWaitDelay bounds how long Wait may block on a grandchild that
	// inherited a subprocess's stdout: exec.CommandContext kills only the
	// direct child, and without this Output() blocks until the grandchild exits
	// too. The clock also starts when the child exits by itself, so 30 s is
	// generous enough not to cut off a tool's own late-writing helper.
	commandWaitDelay = 30 * time.Second
)

// hardwareProfileStep names the hardware profile in IncompleteSteps. It is
// collected like a step but is not in any platform's step list.
const hardwareProfileStep = "hardware_profile"

// collectionInterruptedError reports that ctx ended before a collection step
// finished: the step's own deadline, or (RunEnded) the whole collection's
// budget or the run being cancelled, in which case a step may not have got
// going at all. Err is whatever the step itself returned, if it returned at
// all. The message leaves the step's name to the caller, which already prefixes
// it (runCollectionSteps, runBestEffortSteps, the step= log attribute).
type collectionInterruptedError struct {
	Step     string
	Elapsed  time.Duration
	RunEnded bool
	Cause    error // the context's error
	Err      error
}

func (e *collectionInterruptedError) Error() string {
	by := "its deadline"
	if e.RunEnded {
		by = "the collection's time budget or the run's cancellation"
	}
	msg := fmt.Sprintf("stopped by %s after %s: %s", by, e.Elapsed.Round(time.Millisecond), e.Cause)
	if e.Err != nil && !errors.Is(e.Err, e.Cause) {
		msg += ": " + e.Err.Error()
	}
	return msg
}

func (e *collectionInterruptedError) Unwrap() []error {
	if e.Err == nil {
		return []error{e.Cause}
	}
	return []error{e.Cause, e.Err}
}

func isCollectionInterrupted(err error) bool {
	var interrupted *collectionInterruptedError
	return errors.As(err, &interrupted)
}

type boundedResult[T any] struct {
	val T
	err error
}

// runBounded calls fn with a context that ends after timeout (or with ctx) and
// waits no longer than that plus abandonGrace.
//
// Any fn that finishes after its context ended comes back as a
// *collectionInterruptedError, even if fn itself reported success: several
// steps treat a failed subprocess as best-effort (a missing dpkg must not fail
// the step), so a killed one is otherwise indistinguishable from a clean run
// that merely found nothing. Whatever fn did return is passed on, so a partial
// capture stays usable. A panic in fn becomes an error; a recover further up
// the stack could not catch it on this goroutine.
func runBounded[T any](ctx context.Context, name string, timeout time.Duration, fn func(context.Context) (T, error)) (T, error) {
	start := time.Now()
	boundCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	done := make(chan boundedResult[T], 1) // buffered: an abandoned fn never blocks on send
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- boundedResult[T]{err: fmt.Errorf("panic: %v", r)}
			}
		}()
		val, err := fn(boundCtx)
		done <- boundedResult[T]{val: val, err: err}
	}()

	var res boundedResult[T]
	select {
	case res = <-done:
	case <-boundCtx.Done():
		grace := time.NewTimer(abandonGrace)
		defer grace.Stop()
		select {
		case res = <-done:
		case <-grace.C:
			slog.Warn("systemstate: collection step did not stop when its deadline passed, leaving it behind",
				"step", name, "elapsed", time.Since(start).Round(time.Millisecond).String())
		}
	}

	if cause := boundCtx.Err(); cause != nil {
		return res.val, &collectionInterruptedError{
			Step: name, Elapsed: time.Since(start), RunEnded: ctx.Err() != nil, Cause: cause, Err: res.err,
		}
	}
	return res.val, res.err
}

// runStep runs one collection step under stepTimeout.
func runStep(ctx context.Context, s collectionStep, stagingDir string) ([]Artifact, error) {
	return runBounded(ctx, s.name, stepTimeout, func(stepCtx context.Context) ([]Artifact, error) {
		return s.fn(stepCtx, stagingDir)
	})
}

// runBestEffortSteps is the step loop of the collectors with no required steps
// (Linux, macOS): a failed step is logged and the run carries on, and it is an
// error only if nothing at all was captured.
//
// Only an interrupted step reaches IncompleteSteps. A step that failed on its
// own (no systemctl on this host, iptables-save refused) stays a log line, as
// it always has on these platforms: such a failure is permanent for the host
// and would otherwise put a warning on every one of its runs.
func runBestEffortSteps(ctx context.Context, manifest *SystemStateManifest, steps []collectionStep, stagingDir string) error {
	var reasons []string
	for _, s := range steps {
		arts, err := runStep(ctx, s, stagingDir)
		manifest.Artifacts = append(manifest.Artifacts, arts...)
		if err == nil {
			continue
		}
		slog.Warn("systemstate: step failed", "step", s.name, "error", err.Error())
		reasons = append(reasons, s.name+": "+err.Error())
		if isCollectionInterrupted(err) {
			manifest.IncompleteSteps = append(manifest.IncompleteSteps, s.name)
		}
	}
	if len(manifest.Artifacts) == 0 {
		// Carry each step's reason: this string becomes the job's "not
		// collected" warning, and "all steps failed" alone hides a hung disk.
		return fmt.Errorf("system state collection produced no artifacts - all %d steps failed: %s",
			len(steps), strings.Join(reasons, "; "))
	}
	return nil
}

// attachHardwareProfile fills manifest.HardwareProfile. The profile is best
// effort, so a collector error is only logged; running out of time is also
// named in IncompleteSteps, since the profile may then be missing or partial.
func attachHardwareProfile(ctx context.Context, manifest *SystemStateManifest, collect func(context.Context) (*HardwareProfile, error)) {
	hw, err := runBounded(ctx, hardwareProfileStep, stepTimeout, collect)
	if err != nil {
		slog.Warn("systemstate: hardware profile failed", "error", err.Error())
		if isCollectionInterrupted(err) {
			manifest.IncompleteSteps = append(manifest.IncompleteSteps, hardwareProfileStep)
		}
	}
	if hw != nil {
		manifest.HardwareProfile = hw
	}
}

// osVersion runs a platform's version probe under versionTimeout, answering
// fallback if it does not finish.
func osVersion(ctx context.Context, fallback string, probe func(context.Context) string) string {
	version, err := runBounded(ctx, "os_version", versionTimeout, func(probeCtx context.Context) (string, error) {
		return probe(probeCtx), nil
	})
	if err != nil {
		slog.Warn("systemstate: OS version probe failed", "error", err.Error())
		return fallback
	}
	return version
}

// collectorCommand is every subprocess the collector runs: placed by procspawn,
// killed when ctx ends, and unable to outlive that through a grandchild holding
// its stdout (see commandWaitDelay). Stdin stays nil, which os/exec connects to
// the null device, so a tool that prompts reads EOF rather than waiting.
func collectorCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := procspawn.CommandContext(ctx, name, args...)
	cmd.WaitDelay = commandWaitDelay
	return cmd
}

// contextReader fails a read once ctx has ended. In a file-to-file copy it also
// keeps io.Copy off copy_file_range, which hands the whole file to one
// uninterruptible syscall: the frame every hung goroutine in #11201 sat in.
type contextReader struct {
	ctx context.Context
	r   io.Reader
}

func (c contextReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
