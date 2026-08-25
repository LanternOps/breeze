package rollback

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Engine struct {
	store *Store
	env   Environment
	mu    sync.Mutex
}

func NewEngine(store *Store, env Environment) *Engine {
	if env.Now == nil {
		env.Now = time.Now
	}
	return &Engine{store: store, env: env}
}

func (e *Engine) validate(d Directive) (string, error) {
	payload, err := CanonicalBytes(d)
	if err != nil {
		return "", err
	}
	if d.RollbackID == "" || d.DeviceID != e.env.DeviceID || d.OrgID != e.env.OrgID {
		return "", fmt.Errorf("rollback identity mismatch")
	}
	platform := e.env.Platform
	if platform == "" {
		platform = runtime.GOOS
		if platform == "darwin" {
			platform = "macos"
		}
	}
	arch := e.env.Architecture
	if arch == "" {
		arch = runtime.GOARCH
	}
	if d.Platform != platform || d.Architecture != arch || d.CurrentVersion != e.env.CurrentVersion {
		return "", fmt.Errorf("rollback runtime binding mismatch")
	}
	expires, _ := time.Parse("2006-01-02T15:04:05Z", d.ExpiresAt)
	if !expires.After(e.env.Now()) {
		return "", fmt.Errorf("rollback directive expired")
	}
	if len(d.Artifacts) == 0 || len(d.ComponentVersions) != len(d.Artifacts) {
		return "", fmt.Errorf("rollback component set mismatch")
	}
	seen := map[Component]struct{}{}
	for _, artifact := range d.Artifacts {
		binding, ok := d.ComponentVersions[string(artifact.Component)]
		if !ok || binding.Current != artifact.CurrentVersion || binding.Target != artifact.TargetVersion || artifact.TargetVersion != d.TargetVersion {
			return "", fmt.Errorf("rollback artifact binding mismatch")
		}
		if _, ok := seen[artifact.Component]; ok {
			return "", fmt.Errorf("duplicate rollback component")
		}
		seen[artifact.Component] = struct{}{}
		if len(artifact.SHA256) != 64 || artifact.Size <= 0 || strings.TrimSpace(artifact.DownloadURL) == "" {
			return "", fmt.Errorf("invalid rollback artifact")
		}
		if _, err := hex.DecodeString(artifact.SHA256); err != nil {
			return "", fmt.Errorf("invalid rollback artifact checksum")
		}
	}
	signature, err := base64.StdEncoding.DecodeString(d.DirectiveSignature)
	if err != nil || len(signature) != 64 {
		return "", fmt.Errorf("invalid rollback directive signature encoding")
	}
	if e.env.VerifySignature == nil {
		return "", fmt.Errorf("rollback signature verifier unavailable")
	}
	if err := e.env.VerifySignature(d.DirectiveSigningKeyID, payload, signature); err != nil {
		return "", fmt.Errorf("verify rollback directive: %w", err)
	}
	return digestHex(payload), nil
}

func observationComponentVersions(d Directive, phase, prior Phase) map[string]string {
	useTarget := phase == PhaseSwapped || phase == PhaseRestartRequested || phase == PhaseHealthy
	if phase == PhaseFailed {
		useTarget = prior == PhaseSwapped || prior == PhaseRestartRequested || prior == PhaseHealthy
	}
	versions := make(map[string]string, len(d.ComponentVersions))
	for component, binding := range d.ComponentVersions {
		if useTarget {
			versions[component] = binding.Target
		} else {
			versions[component] = binding.Current
		}
	}
	return versions
}

func observation(d Directive, phase, prior Phase, now time.Time, failure string) Observation {
	sum := sha256.Sum256([]byte(d.RollbackID + "\x00" + string(phase) + "\x00" + now.UTC().Format(time.RFC3339Nano) + "\x00" + failure))
	return Observation{SchemaVersion: 1, ObservationID: hex.EncodeToString(sum[:]), RollbackID: d.RollbackID, DeviceID: d.DeviceID, Phase: phase, CurrentVersion: d.CurrentVersion, ComponentVersions: observationComponentVersions(d, phase, prior), ObservedAt: now.UTC(), ErrorCode: failure}
}

func (e *Engine) transition(state *stateFile, rec *record, phase Phase, failure string) error {
	prior := rec.Phase
	rec.Phase = phase
	rec.Observation = observation(rec.Directive, phase, prior, e.env.Now(), failure)
	state.Active = rec
	state.Pending = append(state.Pending, rec.Observation)
	if phase == PhaseHealthy || phase == PhaseFailed || phase == PhaseRecovered {
		state.Tombstones[rec.Directive.RollbackID] = *rec
		state.Active = nil
	}
	return e.store.saveLocked(*state)
}

func (e *Engine) Execute(ctx context.Context, d Directive) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	digest, err := e.validate(d)
	if err != nil {
		return err
	}
	state, err := e.store.loadLocked()
	if err != nil {
		return err
	}
	if prior, ok := state.Tombstones[d.RollbackID]; ok {
		if prior.Digest != digest {
			return fmt.Errorf("rollback id replayed with changed content")
		}
		return nil
	}
	if state.Active != nil {
		if state.Active.Directive.RollbackID != d.RollbackID {
			return fmt.Errorf("another rollback is active")
		}
		if state.Active.Digest != digest {
			return fmt.Errorf("rollback id replayed with changed content")
		}
		return nil
	}
	rec := &record{Digest: digest, Directive: d}
	if err := e.transition(&state, rec, PhaseReceived, ""); err != nil {
		return err
	}
	if e.env.Backend == nil {
		_ = e.transition(&state, rec, PhaseFailed, "backend_unavailable")
		return fmt.Errorf("rollback backend unavailable")
	}
	if err := e.env.Backend.Prepare(ctx, d); err != nil {
		_ = e.transition(&state, rec, PhaseFailed, "prepare_failed")
		return err
	}
	for _, phase := range []Phase{PhaseDownloaded, PhaseVerified, PhaseStaged} {
		if err := e.transition(&state, rec, phase, ""); err != nil {
			return err
		}
	}
	if err := e.env.Backend.Swap(ctx, d); err != nil {
		if recoverErr := e.env.Backend.Recover(ctx, d); recoverErr == nil {
			_ = e.transition(&state, rec, PhaseRecovered, "swap_failed")
		} else {
			_ = e.transition(&state, rec, PhaseFailed, "swap_and_recovery_failed")
		}
		return err
	}
	if err := e.transition(&state, rec, PhaseSwapped, ""); err != nil {
		return err
	}
	if err := e.transition(&state, rec, PhaseRestartRequested, ""); err != nil {
		return err
	}
	if err := e.env.Backend.Restart(ctx, d); err != nil {
		if recoverErr := e.env.Backend.Recover(ctx, d); recoverErr == nil {
			_ = e.transition(&state, rec, PhaseRecovered, "restart_failed")
		} else {
			_ = e.transition(&state, rec, PhaseFailed, "restart_and_recovery_failed")
		}
		return err
	}
	return nil
}

func (e *Engine) Reconcile(ctx context.Context) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	state, err := e.store.loadLocked()
	if err != nil || state.Active == nil {
		return err
	}
	rec := state.Active
	if rec.Phase == PhaseStaged {
		if err := e.env.Backend.Recover(ctx, rec.Directive); err != nil {
			_ = e.transition(&state, rec, PhaseFailed, "interrupted_swap_recovery_failed")
			return err
		}
		return e.transition(&state, rec, PhaseRecovered, "interrupted_swap")
	}
	if rec.Phase != PhaseSwapped && rec.Phase != PhaseRestartRequested {
		return e.transition(&state, rec, PhaseFailed, "interrupted_before_swap")
	}
	healthy, healthErr := e.env.Backend.Healthy(ctx, rec.Directive)
	if healthErr == nil && healthy {
		if err := e.env.Backend.Finalize(ctx, rec.Directive); err != nil {
			return err
		}
		return e.transition(&state, rec, PhaseHealthy, "")
	}
	if err := e.env.Backend.Recover(ctx, rec.Directive); err != nil {
		_ = e.transition(&state, rec, PhaseFailed, "health_and_recovery_failed")
		return err
	}
	// Persist terminal recovery before requesting the second restart: on
	// Windows the detached service restart may stop this process immediately.
	// The next process then boots the restored old set without re-entering a
	// recovery loop.
	if err := e.transition(&state, rec, PhaseRecovered, "health_failed"); err != nil {
		return err
	}
	if err := e.env.Backend.Restart(ctx, rec.Directive); err != nil {
		_ = e.transition(&state, rec, PhaseFailed, "recovery_restart_failed")
		return err
	}
	return nil
}

func (e *Engine) PendingObservation() (*Observation, error) {
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	state, err := e.store.loadLocked()
	if err != nil || len(state.Pending) == 0 {
		return nil, err
	}
	copy := state.Pending[0]
	return &copy, nil
}

// Active fails closed on unreadable durable state so ordinary component
// updates cannot race a rollback whose state file cannot be inspected.
func (e *Engine) Active() bool {
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	state, err := e.store.loadLocked()
	return err != nil || state.Active != nil
}

func (e *Engine) Acknowledge(id string) error {
	e.store.mu.Lock()
	defer e.store.mu.Unlock()
	state, err := e.store.loadLocked()
	if err != nil {
		return err
	}
	for index := range state.Pending {
		if state.Pending[index].ObservationID != id {
			continue
		}
		state.Pending = append(state.Pending[:index], state.Pending[index+1:]...)
		return e.store.saveLocked(state)
	}
	return nil
}
