//go:build linux

package isolation

import (
	"context"
	"errors"
	"fmt"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// BootApplyAndRestore is `boot-apply` on Linux. Unlike WFP's persistent filters
// and boot-time filters, nft rules do not survive a reboot, so a committed
// episode has to be put back before network-pre.target or the host would boot
// unisolated until the agent starts (spec §3.5 Linux persistence row).
//
// BootApply runs first and settles the journal: it releases what expired and
// cleans up an unfinished apply. Whatever is still committed afterwards is
// valid, and gets the boot rule set: the baseline and any scope:"any" permits.
// The agent's process-scoped permits need its cgroup, which does not exist yet;
// the agent's startup re-verify sees the digest differ and re-applies the full
// rules. A failure here still runs the restore: isolating on a partial result
// is the safe direction, and recovery stays armed either way.
func (m *Manager) BootApplyAndRestore(ctx context.Context) error {
	return errors.Join(m.BootApply(ctx), m.restoreBootRules(ctx))
}

func (m *Manager) restoreBootRules(ctx context.Context) error {
	loader, ok := m.deps.Isolator.(interface {
		applyBootRules(context.Context, ResolvedSpec) error
	})
	if !ok {
		return nil
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	o, err := m.begin(ctx)
	if err != nil {
		return err
	}
	defer o.end()
	if o.state.Phase != journal.PhaseCommitted || o.j.Episode == nil {
		return nil
	}
	owned, err := m.deps.Isolator.Owned(ctx)
	if err != nil {
		return fmt.Errorf("inspect isolation rules at boot: %w", err)
	}
	if owned {
		return nil // Not a reboot; the running rule set stays.
	}
	spec, err := priorSpec(o.j)
	if err != nil {
		return fmt.Errorf("rebuild the journalled rules at boot: %w", err)
	}
	if err := loader.applyBootRules(ctx, spec); err != nil {
		return fmt.Errorf("restore isolation at boot: %w", err)
	}
	log.Info("isolation rules restored at boot", "isolationId", spec.IsolationID)
	return nil
}
