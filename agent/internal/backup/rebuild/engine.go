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
	"time"

	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// runState is the engine's resumable on-disk state: which phases already
// completed destructively (provision, restore) so a re-run after a failure
// does not repeat them.
type runState struct {
	SnapshotID string         `json:"snapshotId"`
	TargetKey  string         `json:"targetKey"`
	Plan       *Plan          `json:"plan"`
	Disk       string         `json:"disk,omitempty"` // attached device (disk targets); images re-attach on resume
	Completed  map[Phase]bool `json:"completed"`
	UpdatedAt  time.Time      `json:"updatedAt"`
}

// run carries one Run call's working state across its phase functions.
type run struct {
	opts      Options
	sys       System
	result    *Result
	state     *runState
	statePath string
	disk      string       // block device under provisioning (/dev/sdb or /dev/loopN)
	detach    func() error // image targets
	staging   string
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
	layout       *layout.Manifest
	manifest     *backup.Snapshot
	warnings     []string
}

func targetKey(t Target) string {
	h := sha256.Sum256([]byte(string(t.Kind) + ":" + t.Path))
	return hex.EncodeToString(h[:])[:12]
}

// Run executes the seven phases (preflight, provision, restore, boot,
// identity, encryption, validate). It returns (result, nil) on success and
// (result, err) on refusal or failure — result is never nil once options
// validate.
func Run(ctx context.Context, opts Options) (*Result, error) {
	start := time.Now()
	if opts.SnapshotID == "" || opts.Provider == nil {
		return nil, errors.New("rebuild: snapshot id and provider are required")
	}
	if opts.Target.Kind != TargetDisk && opts.Target.Kind != TargetImage {
		return nil, fmt.Errorf("rebuild: unknown target kind %q", opts.Target.Kind)
	}
	if opts.Identity == "" {
		opts.Identity = IdentityOriginal
	}
	if opts.StateDir == "" {
		opts.StateDir = "/var/lib/breeze/rebuild"
	}
	if opts.StagingRoot == "" {
		opts.StagingRoot = filepath.Join(opts.StateDir, "mnt", opts.SnapshotID)
	}
	if opts.System == nil {
		opts.System = NewSystem()
		if opts.System == nil {
			return nil, ErrUnsupportedHost
		}
	}
	r := &run{opts: opts, sys: opts.System, staging: opts.StagingRoot,
		result: &Result{SnapshotID: opts.SnapshotID, Target: opts.Target, Identity: opts.Identity, Status: "failed"}}
	r.statePath = filepath.Join(opts.StateDir, fmt.Sprintf("rebuild-%s-%s.json", opts.SnapshotID, targetKey(opts.Target)))
	if opts.ForceReprovision {
		_ = os.Remove(r.statePath)
	}
	r.loadState()
	defer r.teardown()

	type phaseFn struct {
		phase Phase
		fn    func(context.Context, *run) error
	}
	phases := []phaseFn{
		{PhasePreflight, preflight}, {PhaseProvision, provision}, {PhaseRestore, restoreTree},
		{PhaseBoot, boot}, {PhaseIdentity, identity}, {PhaseEncryption, encryption}, {PhaseValidate, validate},
	}
	for _, p := range phases {
		r.result.PhaseReached = p.phase
		pr := PhaseResult{Phase: p.phase, StartedAt: time.Now().UTC()}
		if r.state.Completed[p.phase] && p.phase != PhasePreflight && p.phase != PhaseValidate {
			pr.Status, pr.Message, pr.CompletedAt = PhaseSkipped, "already completed by an earlier run", time.Now().UTC()
			r.result.Phases = append(r.result.Phases, pr)
			r.result.Resumed = true
			if p.phase == PhaseProvision || p.phase == PhaseRestore {
				if err := r.reattach(ctx); err != nil { // mounts the already-provisioned partitions
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
				r.result.DurationMs = time.Since(start).Milliseconds()
				return r.result, err
			}
			return r.fail(start, pr, err)
		}
		pr.Status = PhaseCompleted
		r.result.Phases = append(r.result.Phases, pr)
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
	}
	return r.result, nil
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
		r.disk = s.Disk
	}
}

func (r *run) saveState() {
	r.state.UpdatedAt = time.Now().UTC()
	r.state.Plan = r.result.Plan
	r.state.Disk = r.disk
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
		}
		r.rootMount = ""
	}
	if r.detach != nil {
		if err := r.detach(); err != nil {
			r.warn("detach image: %v", err)
		}
		r.detach = nil
	}
	if r.stateStaging != "" {
		_ = os.RemoveAll(r.stateStaging)
		r.stateStaging = ""
	}
}
