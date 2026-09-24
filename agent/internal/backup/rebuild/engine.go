package rebuild

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// runState is the engine's resumable on-disk state: which phases already
// completed destructively (provision, restore) so a re-run after a failure
// does not repeat them.
type runState struct {
	SnapshotID   string         `json:"snapshotId"`
	TargetKey    string         `json:"targetKey"`
	Plan         *Plan          `json:"plan"`
	Completed    map[Phase]bool `json:"completed"`
	UpdatedAt    time.Time      `json:"updatedAt"`
	StateApplied bool           `json:"stateApplied,omitempty"`
	// Platform/HostOS record what wrote this state file (Global Constraint
	// "Platform table, not a second engine" — a resume from a different
	// platform/host is refused, never silently reinterpreted).
	Platform string `json:"platform,omitempty"`
	HostOS   string `json:"hostOs,omitempty"`
	// Volumes is the Windows provision phase's partition number -> volume
	// GUID path map, persisted so a resumed run remounts without
	// re-running WriteGPT/Format (Task 11), and so cleanupLeftovers (below)
	// can tell a crashed vhdx: run apart from one that never reached
	// provision.
	Volumes map[int]string `json:"volumes,omitempty"`
}

// run carries one Run call's working state across its phase functions.
type run struct {
	opts      Options
	sys       System    // Linux seam; nil on a Windows run
	winSys    WinSystem // Windows seam; nil on a Linux run
	result    *Result
	state     *runState
	statePath string
	platform  string // "linux" | "windows", set by resolvePlatform

	disk       string
	diskNumber int // Windows: the disk number under provisioning (vhdx: from AttachVHDX, disk: parsed from \\.\PhysicalDriveN)
	detach     func() error

	staging string
	// Mounts are tracked in three groups so teardown can unmount safely
	// AND deterministically: rootMount (the disk's root partition, mounted
	// at r.staging itself) must always be the very LAST thing unmounted —
	// every other mount point here is nested inside it. treeMounts (the
	// rest of mountTree's real partition mounts — /boot, /boot/efi, ...) is
	// unmounted first, deepest (mount order) last-appended first. mounts
	// (boot()'s chroot-prep bind mounts: /dev, /proc, /sys, /run,
	// optionally efivars) is unmounted next, in its own reverse order.
	// Neither group nests inside the other, so their relative order
	// doesn't matter for safety — only that both finish before rootMount.
	rootMount    string
	treeMounts   []string
	mounts       []string // chroot-prep bind mounts, in mount order
	stateStaging string   // downloaded system-state artifacts
	// releaseErr is set when teardown could not unmount the root partition
	// or detach the loop device: the staging image is still live, so
	// convert must not read it.
	releaseErr error
	layout     *layout.Manifest
	manifest   *backup.Snapshot
	warnings   []string
	// failedFiles are source paths the restore phase could not place (only
	// populated under AllowPartialRestore); validate must not sample them —
	// they were already reported as a warning.
	failedFiles map[string]bool
}

func targetKey(t Target) string {
	h := sha256.Sum256([]byte(string(t.Kind) + ":" + t.Path))
	return hex.EncodeToString(h[:])[:12]
}

// phaseFn pairs one phase with the function that implements it for a given
// platform.
type phaseFn struct {
	phase Phase
	fn    func(context.Context, *run) error
}

// platformPhases is the one phase loop's per-platform table: same eight
// phases, same order, for every platform (Global Constraint "One engine").
var platformPhases = map[string][]phaseFn{
	"linux": {
		{PhasePreflight, preflight}, {PhaseProvision, provision}, {PhaseRestore, restoreTree},
		{PhaseBoot, boot}, {PhaseIdentity, identity}, {PhaseEncryption, encryption}, {PhaseValidate, validate},
		{PhaseConvert, convert},
	},
	"windows": {
		{PhasePreflight, winPreflight}, {PhaseProvision, winProvision}, {PhaseRestore, winRestoreTree},
		{PhaseBoot, winBoot}, {PhaseIdentity, winIdentity}, {PhaseEncryption, winEncryption}, {PhaseValidate, winValidate},
		{PhaseConvert, winConvert},
	},
}

// hostPlatform maps runtime.GOOS onto layout.Platform values; "" = no
// engine for this host. A var so tests can pin it (engine_test.go TestMain).
var hostPlatform = func() string {
	switch runtime.GOOS {
	case "linux", "windows":
		return runtime.GOOS
	}
	return ""
}

// SetHostPlatformForTest pins the platform Run believes it runs on and
// returns the undo. Test-only by convention (like
// backup.SetVolumeNameForTest): other packages' tests (cmd/breeze-backup)
// drive the Linux engine through a fake System on macOS dev hosts.
func SetHostPlatformForTest(p string) (restore func()) {
	prev := hostPlatform
	hostPlatform = func() string { return p }
	return func() { hostPlatform = prev }
}

// Run executes the eight phases (preflight, provision, restore, boot,
// identity, encryption, validate, convert). It returns (result, nil) on success and
// (result, err) on refusal or failure — result is never nil once options
// validate.
func Run(ctx context.Context, opts Options) (*Result, error) {
	start := time.Now()
	if opts.SnapshotID == "" || opts.Provider == nil {
		return nil, errors.New("rebuild: snapshot id and provider are required")
	}
	if opts.Target.Kind != TargetDisk && opts.Target.Kind != TargetImage && opts.Target.Kind != TargetVHDX {
		return nil, fmt.Errorf("rebuild: unknown target kind %q", opts.Target.Kind)
	}
	if opts.Identity == "" {
		opts.Identity = IdentityOriginal
	}
	if opts.StateDir == "" {
		if hostPlatform() == "windows" {
			pd := os.Getenv("ProgramData")
			if pd == "" {
				pd = `C:\ProgramData`
			}
			opts.StateDir = filepath.Join(pd, "Breeze", "rebuild")
		} else {
			opts.StateDir = "/var/lib/breeze/rebuild"
		}
	}
	if opts.StagingRoot == "" {
		opts.StagingRoot = filepath.Join(opts.StateDir, "mnt", opts.SnapshotID)
	}
	if opts.WorkRoot == "" && hostPlatform() == "windows" && opts.Target.Kind == TargetVHDX {
		// disk: (WinPE) targets compute WorkRoot lazily once the staging
		// root is mounted (Global Constraint "Work dir") — winRestoreTree,
		// Task 11.
		opts.WorkRoot = filepath.Join(opts.StateDir, "work", opts.SnapshotID)
	}
	if opts.System == nil {
		opts.System = NewSystem() // nil off Linux
	}
	if opts.WinSystem == nil && hostPlatform() == "windows" {
		opts.WinSystem = NewWinSystem()
	}
	r := &run{opts: opts, sys: opts.System, winSys: opts.WinSystem, staging: opts.StagingRoot,
		result: &Result{SnapshotID: opts.SnapshotID, Target: opts.Target, Identity: opts.Identity, Status: "failed"}}
	r.statePath = filepath.Join(opts.StateDir, fmt.Sprintf("rebuild-%s-%s.json", opts.SnapshotID, targetKey(opts.Target)))
	if opts.ForceReprovision {
		_ = os.Remove(r.statePath)
	}
	cleanupLeftovers(r)
	r.loadState()
	defer r.teardown()

	if err := resolvePlatform(ctx, r); err != nil {
		if errors.Is(err, ErrUnsupportedHost) {
			return nil, err
		}
		// Layout fetch and platform checks were preflight's first step
		// before this refactor; they still report as the preflight phase.
		r.result.PhaseReached = PhasePreflight
		pr := PhaseResult{Phase: PhasePreflight, StartedAt: time.Now().UTC()}
		var ref *RefusalError
		if errors.As(err, &ref) {
			pr.Status, pr.Message, pr.CompletedAt = PhaseRefused, ref.Reason, time.Now().UTC()
			r.result.Phases = append(r.result.Phases, pr)
			r.result.Status, r.result.Refusal = "refused", ref.Reason
			r.result.Warnings = r.warnings
			r.result.DurationMs = time.Since(start).Milliseconds()
			return r.result, err
		}
		return r.fail(start, pr, err)
	}
	r.result.Platform = r.platform

	switch r.platform {
	case "linux":
		if r.sys == nil {
			return nil, ErrUnsupportedHost
		}
	case "windows":
		if r.winSys == nil {
			return nil, ErrUnsupportedHost
		}
	}

	phases, ok := platformPhases[r.platform]
	if !ok {
		return nil, fmt.Errorf("rebuild: no phase table for platform %q", r.platform)
	}
	for _, p := range phases {
		r.result.PhaseReached = p.phase
		pr := PhaseResult{Phase: p.phase, StartedAt: time.Now().UTC()}
		if r.state.Completed[p.phase] && p.phase != PhasePreflight && p.phase != PhaseValidate {
			pr.Status, pr.Message, pr.CompletedAt = PhaseSkipped, "already completed by an earlier run", time.Now().UTC()
			r.result.Phases = append(r.result.Phases, pr)
			r.result.Resumed = true
			if p.phase == PhaseProvision || p.phase == PhaseRestore {
				if err := r.reattachForResume(ctx); err != nil {
					return r.fail(start, pr, err)
				}
			}
			continue
		}
		r.progress(p.phase, "starting", 0, 0)
		err := p.fn(ctx, r)
		pr.CompletedAt = time.Now().UTC()
		if err != nil {
			var ref *RefusalError
			if errors.As(err, &ref) {
				pr.Status, pr.Message = PhaseRefused, ref.Reason
				r.result.Phases = append(r.result.Phases, pr)
				r.result.Status, r.result.Refusal = "refused", ref.Reason
				r.result.Warnings = r.warnings
				r.result.DurationMs = time.Since(start).Milliseconds()
				return r.result, err
			}
			return r.fail(start, pr, err)
		}
		if !r.recorded(p.phase) { // a phase that recordSkipped itself already owns its row
			pr.Status = PhaseCompleted
			r.result.Phases = append(r.result.Phases, pr)
		}
		r.state.Completed[p.phase] = true
		if p.phase != PhasePreflight {
			r.saveState()
		}
		if opts.DryRun && p.phase == PhasePreflight {
			break
		}
	}
	r.result.Status = "completed"
	r.result.Warnings = r.warnings
	r.result.DurationMs = time.Since(start).Milliseconds()
	if !opts.DryRun {
		_ = os.Remove(r.statePath)
		_ = os.RemoveAll(restoreWorkRoot(opts.StateDir))
	}
	return r.result, nil
}

// reattachForResume dispatches a resumed run's re-mount step to the right
// platform twin: reattach (provision.go, Linux) or winReattach
// (win_provision.go, Task 11 — stubbed in win_phases.go until then).
func (r *run) reattachForResume(ctx context.Context) error {
	if r.platform == "windows" {
		return r.winReattach(ctx)
	}
	return r.reattach(ctx)
}

// resolvePlatform fetches and schema-checks the layout (moved out of
// preflight.go's old inline block, which both platform preflights used to
// duplicate), refuses a platform/host mismatch, and refuses a resume state
// file written on a different platform/host — all BEFORE any phase runs,
// so a wrong-platform snapshot never triggers a manifest download.
// layout.Assess is deliberately NOT called here — it stays inside each
// platform's own preflight (preflight.go's preflight, win_preflight.go's
// winPreflight), each with a platform-specific refusal message.
func resolvePlatform(ctx context.Context, r *run) error {
	host := hostPlatform()
	if host == "" {
		return ErrUnsupportedHost
	}
	lay := r.opts.Layout
	if lay == nil {
		var err error
		if lay, err = fetchLayout(ctx, r.opts.Provider, r.opts.SnapshotID); err != nil {
			return err
		}
	} else if lay.SchemaVersion != layout.SchemaVersion {
		return &RefusalError{Reason: fmt.Sprintf("layout schema version %d is not supported by this helper (supports %d)", lay.SchemaVersion, layout.SchemaVersion)}
	}
	if lay.Platform != host {
		return &RefusalError{Reason: fmt.Sprintf("snapshot platform %q cannot be rebuilt on a %s host", lay.Platform, host)}
	}
	if len(r.state.Completed) > 0 && r.state.Platform != "" && (r.state.Platform != lay.Platform || r.state.HostOS != host) {
		return &RefusalError{Reason: fmt.Sprintf("resume state was written on a %s host for platform %q", r.state.HostOS, r.state.Platform)}
	}
	r.layout = lay
	r.platform = host
	r.state.Platform, r.state.HostOS = lay.Platform, host
	return nil
}

func (r *run) fail(start time.Time, pr PhaseResult, err error) (*Result, error) {
	pr.Status, pr.Message, pr.CompletedAt = PhaseFailed, err.Error(), time.Now().UTC()
	r.result.Phases = append(r.result.Phases, pr)
	r.result.Status, r.result.Error = "failed", err.Error()
	r.result.Warnings = r.warnings
	r.result.DurationMs = time.Since(start).Milliseconds()
	r.saveState() // keeps completed phases for resume
	return r.result, err
}

// recordSkipped is how a phase function reports "nothing to do for this
// target" without failing: it appends its own PhaseSkipped row so the
// phase table keeps every entry of AllPhases for every caller, and the Run
// loop (see recorded) then does not append a second, "completed" row.
func (r *run) recordSkipped(ph Phase, msg string) {
	now := time.Now().UTC()
	r.result.Phases = append(r.result.Phases, PhaseResult{Phase: ph, Status: PhaseSkipped, StartedAt: now, CompletedAt: now, Message: msg})
}

// recorded reports whether the most recent phase row already belongs to ph.
func (r *run) recorded(ph Phase) bool {
	n := len(r.result.Phases)
	return n > 0 && r.result.Phases[n-1].Phase == ph
}

func (r *run) progress(ph Phase, msg string, cur, total int64) {
	if r.opts.Progress != nil {
		r.opts.Progress(ph, msg, cur, total)
	}
}

func (r *run) warn(format string, args ...any) {
	r.warnings = append(r.warnings, fmt.Sprintf(format, args...))
}

func (r *run) loadState() {
	r.state = &runState{SnapshotID: r.opts.SnapshotID, TargetKey: targetKey(r.opts.Target), Completed: map[Phase]bool{}}
	data, err := os.ReadFile(r.statePath)
	if err != nil {
		return
	}
	var s runState
	if json.Unmarshal(data, &s) == nil && s.SnapshotID == r.opts.SnapshotID && s.TargetKey == r.state.TargetKey && s.Plan != nil {
		if s.Completed == nil {
			s.Completed = map[Phase]bool{}
		}
		r.state = &s
		r.result.Plan = s.Plan
		if s.Completed[PhaseRestore] {
			r.result.StateApplied = s.StateApplied
		}
		// r.disk is deliberately NOT restored from persisted state: a
		// TargetImage's loop device does not survive across Run() calls
		// (teardown always detaches it, even on failure — see teardown's
		// doc comment), so trusting a persisted device path here would mean
		// mounting a stale or foreign loop device on resume. reattach()
		// always re-derives it (cheap recompute for TargetDisk, a fresh
		// AttachImage for TargetImage) whenever r.disk == "".
	}
}

func (r *run) saveState() {
	r.state.UpdatedAt = time.Now().UTC()
	r.state.Plan = r.result.Plan
	if err := os.MkdirAll(filepath.Dir(r.statePath), 0o700); err != nil {
		return
	}
	data, _ := json.MarshalIndent(r.state, "", "  ")
	tmp := r.statePath + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, r.statePath)
	}
}

// teardown unmounts everything (deepest first, rootMount always last —
// see the run struct's mount-field doc comment), detaches the loop device,
// and removes the system-state staging dir. Errors are warnings: the
// result already carries the outcome.
func (r *run) teardown() {
	ctx := context.Background()
	for i := len(r.treeMounts) - 1; i >= 0; i-- {
		if err := r.sys.Unmount(ctx, r.treeMounts[i]); err != nil {
			r.warn("unmount %s: %v", r.treeMounts[i], err)
		}
	}
	r.treeMounts = nil
	for i := len(r.mounts) - 1; i >= 0; i-- {
		if err := r.sys.Unmount(ctx, r.mounts[i]); err != nil {
			r.warn("unmount %s: %v", r.mounts[i], err)
		}
	}
	r.mounts = nil
	if r.rootMount != "" {
		if err := r.sys.Unmount(ctx, r.rootMount); err != nil {
			r.warn("unmount %s: %v", r.rootMount, err)
			r.releaseErr = err
		}
		r.rootMount = ""
	}
	if r.detach != nil {
		if err := r.detach(); err != nil {
			r.warn("detach image: %v", err)
			r.releaseErr = err
		}
		r.detach = nil
	}
	if r.stateStaging != "" {
		_ = os.RemoveAll(r.stateStaging)
		r.stateStaging = ""
	}
}
