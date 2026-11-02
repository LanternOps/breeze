package isolation

import (
	"context"
	"errors"
	"fmt"
	"io/fs"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// RecoveryExpireCheck evaluates the independent recovery timer without network
// probes or new rule installation. It works while the activation switch is off.
func (m *Manager) RecoveryExpireCheck(ctx context.Context) error {
	return m.recoveryCheck(ctx, false)
}

// BootApply cleans up an unfinished first apply, interrupted release, expired
// episode or invalid clock. Existing filters never promote a provisional apply.
// A still-valid committed episode remains for the agent to re-verify at startup.
func (m *Manager) BootApply(ctx context.Context) error {
	return m.recoveryCheck(ctx, true)
}

func (m *Manager) recoveryCheck(ctx context.Context, boot bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	o, err := m.begin(ctx)
	if err != nil {
		return err
	}
	defer o.end()
	if !activePhase(o.state.Phase) {
		owned, err := m.deps.Isolator.Owned(ctx)
		if err != nil {
			return fmt.Errorf("inspect recovery rules: %w", err)
		}
		if owned || o.state.RulesMayExist {
			o.state.RulesMayExist = true
			return o.runRecovery(Event{Kind: EvRelease, ReleaseKind: ReleaseSystem}, !owned)
		}
		if o.missing {
			return nil
		}
		// A crash can occur after terminal persistence but before task removal.
		return m.deps.Scheduler.RemoveAll()
	}
	if boot && o.state.Phase == journal.PhaseProvisional {
		if o.state.AttemptID == "" {
			// A truncated logical record may still be valid JSON. Without an
			// attempt to fence, explicitly release its journalled episode.
			return o.runRecovery(Event{Kind: EvRelease, ReleaseKind: ReleaseSystem}, false)
		}
		return o.runRecovery(Event{Kind: EvAttemptFailed, AttemptID: o.state.AttemptID, Code: FailApplyError, Err: "recovery found an unfinished provisional apply"}, false)
	}
	return o.runRecovery(Event{Kind: EvTick}, false)
}

// RollbackIfUncommitted acts only on this provisional attempt, re-read under
// the machine lock. A committed or superseding attempt is always left alone.
func (m *Manager) RollbackIfUncommitted(ctx context.Context, attemptID string) error {
	if attemptID == "" {
		return errors.New("rollback attempt is required")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	o, err := m.begin(ctx)
	if err != nil {
		return err
	}
	defer o.end()
	if o.state.Phase != journal.PhaseProvisional || o.state.AttemptID != attemptID {
		return nil
	}
	return o.runRecovery(Event{Kind: EvAttemptFailed, AttemptID: attemptID, Code: FailControlPlaneUnreachable, Err: "independent provisional rollback"}, false)
}

// ReleaseAll removes all Breeze-owned rules and confirms their absence before
// removing recovery tasks. Capability is deliberately irrelevant to release.
// An inaccessible engine is safe only when no journal exists at all. The
// unsupported non-Windows implementation also permits an idle/terminal journal.
func (m *Manager) ReleaseAll(ctx context.Context, kind string) error {
	if !validReleaseKind(kind) {
		return errors.New("unknown isolation release kind")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	o, err := m.begin(ctx)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return m.releaseAllWithoutState(ctx)
		}
		return err
	}
	defer o.end()
	owned, inspectErr := m.deps.Isolator.Owned(ctx)
	if inspectErr != nil {
		if o.missing || (errors.Is(inspectErr, ErrUnsupported) && !activePhase(o.state.Phase) && !o.state.RulesMayExist) {
			if !errors.Is(inspectErr, ErrUnsupported) {
				log.Warn("isolation engine unavailable during release-all; no journal exists, treating device as never isolated", "error", inspectErr.Error())
			}
			return nil
		}
		return fmt.Errorf("cannot confirm isolation absence: %w", inspectErr)
	}
	if !activePhase(o.state.Phase) {
		if !owned && !o.state.RulesMayExist {
			if o.missing {
				return nil
			} // Never isolated: no recovery dependency.
			return m.deps.Scheduler.RemoveAll()
		}
		// Orphan rules cannot be assigned to a journalled episode or rewritten as
		// an uninstall outcome. Preserve a system cleanup receipt instead.
		o.state.RulesMayExist = true
		return o.runRecovery(Event{Kind: EvRelease, ReleaseKind: ReleaseSystem}, !owned)
	}
	if o.state.Phase == journal.PhaseReleasing && o.state.IsolationID == "" {
		// An interrupted orphan cleanup has no episode to release by id; the
		// tick retries its release exactly as recoveryCheck does.
		return o.runRecovery(Event{Kind: EvTick}, !owned)
	}
	return o.runRecovery(Event{Kind: EvRelease, IsolationID: o.state.IsolationID, Generation: o.state.Generation, ReleaseKind: kind}, !owned)
}

// runRecovery executes the same pure state machine as the live agent, but
// returns every persistence, cleanup and scheduler error to the process. It
// never probes or installs rules. A stale refresh is left for agent startup
// to re-verify, preserving upgrade dual-path permits in the meantime.
func (o *op) runRecovery(ev Event, knownAbsent bool) error {
	for steps := 0; ev.Kind != 0 && steps < 64; steps++ {
		if err := o.ctx.Err(); err != nil {
			return err
		}
		next, effects := Step(o.state, ev, o.m.deps.Clock)
		if err := o.persist(next, ev, effects); err != nil {
			return fmt.Errorf("persist recovery transition: %w", err)
		}
		ev = Event{}
		for _, effect := range effects {
			if o.m.beforeEffect != nil {
				if err := o.m.beforeEffect(effect); err != nil {
					o.crashed = true
					return errCrashedOp
				}
			}
			switch effect.Kind {
			case EffRollback:
				if effect.Prior {
					continue
				}
				fallthrough
			case EffReleaseRules:
				if !knownAbsent {
					if err := o.m.deps.Isolator.Release(o.ctx); err != nil {
						return fmt.Errorf("release rules; recovery stays armed: %w", err)
					}
				}
			case EffConfirmAbsent:
				owned, err := o.m.deps.Isolator.Owned(o.ctx)
				if err != nil {
					return fmt.Errorf("confirm absence; recovery stays armed: %w", err)
				}
				if owned {
					return errors.New("breeze-owned rules remain; recovery stays armed")
				}
				ev = Event{Kind: EvAbsentConfirmed}
			case EffDisarmProvisional:
				var err error
				if effect.All {
					err = o.m.deps.Scheduler.RemoveAll()
				} else {
					err = o.m.deps.Scheduler.DisarmProvisional(effect.AttemptID)
				}
				if err != nil {
					return fmt.Errorf("remove recovery task: %w", err)
				}
			case EffReport:
				if effect.Refusal != "" {
					return errors.New(effect.Detail)
				}
			default:
				return fmt.Errorf("unexpected recovery effect %s", effect.Kind)
			}
			if ev.Kind != 0 {
				break
			}
		}
	}
	if ev.Kind != 0 {
		return errors.New("recovery transition limit reached")
	}
	return nil
}

// releaseAllWithoutState handles a missing state directory: no journal and no
// lock can exist, so nothing was ever journalled on this install. It mirrors
// ReleaseAll's no-journal rule: absence confirmed by the engine, or no engine
// at all, lets uninstall proceed; rules the engine still shows refuse it,
// because their release could not be journalled or receipted.
func (m *Manager) releaseAllWithoutState(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	owned, err := m.deps.Isolator.Owned(ctx)
	if err != nil {
		if !errors.Is(err, ErrUnsupported) {
			log.Warn("isolation engine unavailable and no state directory; treating device as never isolated", "error", err.Error())
		}
		return nil // no journal at all: the same rule as an unreadable engine above
	}
	if owned {
		return errors.New("breeze-owned rules exist but the isolation state directory is missing; recovery cannot record their release")
	}
	return nil
}
