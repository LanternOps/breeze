//go:build darwin

package isolation

import (
	"context"
	"fmt"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// macOS recovery differs from Windows in two ways, both forced by the platform:
//
//   - pf keeps no rules, anchor reference or enable reference across a reboot,
//     so a still-valid episode has to be installed again at boot (spec §3.5:
//     the LaunchDaemon re-loads the anchor "only if the journal's expiresAt is
//     in the future"). Windows' persistent WFP filters need none of this.
//   - launchd has no one-shot timer with seconds precision, and it runs a job's
//     one command line both at load and on every interval. So the rollback job
//     polls and the deadline decides, and the boot job cannot assume it is
//     running at boot.

// DarwinBootApply is the com.breeze.isolation job: at load and every 15
// minutes. Expiry is evaluated first, exactly as expire-check does, so an
// episode that ended is released and never re-installed. A provisional attempt
// is judged by its own deadline and boot: the agent loads this job during an
// apply, so it runs mid-apply, and an attempt of this boot still inside its
// window is not "unfinished". Then, if a committed episode's rules are not
// acting (rebooted, pf turned off, anchor flushed or detached), they are
// installed again from the journal.
func (m *Manager) DarwinBootApply(ctx context.Context) error {
	if err := m.recoveryCheck(ctx, false); err != nil {
		return err
	}
	return m.reinstallIfNotEnforcing(ctx)
}

// reinstallIfNotEnforcing never probes and never touches an attempt in flight:
// the agent re-verifies with both probes when it starts. A failure is
// journalled for the next report and returned, so the job exits non-zero and
// the next poll tries again.
func (m *Manager) reinstallIfNotEnforcing(ctx context.Context) error {
	checker, ok := m.deps.Isolator.(interface {
		enforcing(context.Context) (bool, error)
	})
	if !ok {
		return nil
	}
	o, err := m.begin(ctx)
	if err != nil {
		return err
	}
	defer o.end()
	if o.state.Phase != journal.PhaseCommitted || o.state.AttemptID != "" || o.j.Episode == nil {
		return nil
	}
	if exp, _ := expired(o.state.facts(), m.deps.Clock); exp {
		return nil // the next check releases it
	}
	acting, err := checker.enforcing(ctx)
	if err != nil {
		o.noteError("recovery could not inspect the rules: " + err.Error())
		return fmt.Errorf("inspect the isolation rules: %w", err)
	}
	if acting {
		return nil
	}
	spec, err := priorSpec(o.j)
	if err != nil {
		o.noteError("recovery could not rebuild the rules: " + err.Error())
		return fmt.Errorf("rebuild the journalled rules: %w", err)
	}
	spec.BinaryPaths = m.binaryPaths()
	if _, err := m.deps.Isolator.Apply(ctx, spec); err != nil {
		o.noteError("recovery could not re-install the rules: " + err.Error())
		return fmt.Errorf("re-install the isolation rules: %w", err)
	}
	o.j.Append(o.now(), "drift_reapplied", o.state.IsolationID, o.state.Generation, "recovery")
	o.dirty = true
	return nil
}

// DarwinRollbackIfOverdue is the com.breeze.isolation.rollback job, every 15 s
// from the moment an apply arms it. It rolls the attempt back only once its
// deadline has passed (by the wall clock, the monotonic clock, or a reboot),
// retries an interrupted rollback, and otherwise unloads itself: the job for an
// attempt that committed or was superseded has nothing left to protect.
func (m *Manager) DarwinRollbackIfOverdue(ctx context.Context, attemptID string) error {
	if !recoveryAttemptPattern.MatchString(attemptID) {
		return fmt.Errorf("invalid isolation rollback attempt ID %q", attemptID)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	o, err := m.begin(ctx)
	if err != nil {
		return err
	}
	defer o.end()
	switch {
	case o.state.Phase == journal.PhaseProvisional && o.state.AttemptID == attemptID:
		if !o.state.attemptOverdue(m.deps.Clock) {
			return nil
		}
		return o.runRecovery(Event{Kind: EvAttemptFailed, AttemptID: attemptID, Code: FailControlPlaneUnreachable, Err: "independent provisional rollback"}, false)
	case o.state.Phase == journal.PhaseReleasing:
		return o.runRecovery(Event{Kind: EvTick}, false)
	}
	return m.deps.Scheduler.DisarmProvisional(attemptID)
}
