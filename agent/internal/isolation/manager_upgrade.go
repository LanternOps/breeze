package isolation

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// PlatformBinaryPaths exposes only the installed binaries chosen by the platform,
// never paths from a remote command payload.
func PlatformBinaryPaths(iso Isolator) []string {
	if provider, ok := iso.(interface{ BinaryPaths() []string }); ok {
		return provider.BinaryPaths()
	}
	return nil
}

func sortedBinaryPaths(paths []string) []string {
	unique := make(map[string]bool, len(paths))
	for _, p := range paths {
		if p != "" {
			unique[p] = true
		}
	}
	out := make([]string, 0, len(unique))
	for p := range unique {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}

// binaryPaths is called only under opMu. A failed swap conservatively retains
// both sets until restart, including across refresh and refresh rollback.
func (m *Manager) binaryPaths() []string {
	if len(m.handoffBins) > 0 {
		return append([]string(nil), m.handoffBins...)
	}
	if m.deps.BinaryPaths != nil {
		return sortedBinaryPaths(m.deps.BinaryPaths())
	}
	return sortedBinaryPaths(PlatformBinaryPaths(m.deps.Isolator))
}

// PrepareUpgrade runs at the verified artifact's pre-swap boundary. The caller
// obtains supportedSchema from the staged executable, failing closed on errors.
// It must not swap unless this method succeeds. Same-path swaps still check schema.
func (m *Manager) PrepareUpgrade(ctx context.Context, nextBins []string, supportedSchema int) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	// Unlike recovery, an update must never reset an unreadable journal or
	// publish an idle snapshot. Preserve the old gate until recovery confirms
	// absence, even when the updater retries after a schema/read failure.
	m.opMu.Lock()
	unlock, err := journal.Lock(m.deps.DataDir)
	if err != nil {
		m.opMu.Unlock()
		return err
	}
	o := &op{m: m, ctx: ctx, unlock: unlock}
	defer o.end()
	if _, err := journal.Load(m.path()); err != nil {
		if errors.Is(err, journal.ErrNotFound) && !m.Active() {
			return nil
		}
		return fmt.Errorf("read isolation journal before upgrade: %w", err)
	}
	if err := o.load(); err != nil {
		return err
	}
	if !activePhase(o.state.Phase) {
		return nil
	}
	if supportedSchema != journal.SchemaVersion {
		return fmt.Errorf("incompatible isolation journal schema: %d", supportedSchema)
	}
	if o.state.Phase != journal.PhaseCommitted || o.state.AttemptID != "" {
		return errors.New("isolation recovery or verification is in progress")
	}
	next := sortedBinaryPaths(nextBins)
	current := m.binaryPaths()
	if len(next) == 0 || len(current) == 0 {
		return errors.New("cannot determine protected binary paths")
	}
	if reflect.DeepEqual(next, current) {
		return nil
	}
	m.prevBins = append([]string(nil), current...)
	m.handoffBins = sortedBinaryPaths(append(append([]string(nil), current...), next...))
	o.cap = m.deps.Isolator.Capability()
	o.refresh(nil, false)
	if o.crashed || o.lockLost || o.attempt == nil || o.attempt.digest == "" || o.state.Phase != journal.PhaseCommitted || o.j.Episode == nil || o.j.Episode.RuleDigest != string(o.attempt.digest) {
		return errors.New("upgrade permits could not be verified")
	}
	return nil
}
