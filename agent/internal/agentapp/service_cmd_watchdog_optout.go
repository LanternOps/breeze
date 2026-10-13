package agentapp

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// watchdogOptIn is the `service install --watchdog` flag: clear a standing
// opt-out and reset the watchdog install retry state, then install.
var watchdogOptIn bool

const watchdogOptInUsage = "Re-enable automatic watchdog installation after --no-watchdog (also resets the watchdog install retry state)"

// watchdogFlagDeps are applyWatchdogFlags' inputs, injectable for tests.
type watchdogFlagDeps struct {
	store watchdoginstall.Store
	// ensureDir creates the store directory when it is missing and the
	// opt-out marker must be written (Windows: the secured machine config
	// folder). nil = the caller already created it.
	ensureDir func() error
	out       io.Writer
}

func defaultWatchdogFlagDeps(ensureDir func() error) watchdogFlagDeps {
	return watchdogFlagDeps{
		store:     watchdoginstall.Store{Dir: config.MachineConfigDir()},
		ensureDir: ensureDir,
		out:       os.Stdout,
	}
}

// applyWatchdogFlags turns the --no-watchdog / --watchdog flags into persisted
// operator intent and reports whether the watchdog bootstrap must be skipped.
//
//   - --no-watchdog: record the opt-out marker, skip. A marker that cannot be
//     written is a hard error — an opt-out that silently failed would let the
//     running agent install the watchdog later.
//   - --watchdog: clear the marker and reset the retry state, install.
//   - neither, marker present: honour the standing opt-out, skip (scripted
//     upgrade lanes that re-run `service install` must not re-enable a
//     deliberately removed watchdog).
//   - neither, no marker: install (unchanged behaviour).
//
// Called before any install side effect, so a flag error or a failed marker
// write aborts the command cleanly.
func applyWatchdogFlags(d watchdogFlagDeps, noWatchdog, watchdog bool) (skip bool, err error) {
	out := d.out
	if out == nil {
		out = io.Discard
	}
	switch {
	case noWatchdog && watchdog:
		return false, errors.New("--watchdog and --no-watchdog cannot be used together")
	case noWatchdog:
		if err := ensureStoreDir(d); err != nil {
			return false, fmt.Errorf("record watchdog opt-out: %w", err)
		}
		if err := d.store.SetOptedOut(true); err != nil {
			return false, err
		}
		fmt.Fprintln(out, "Watchdog opt-out recorded: neither this install nor the running agent will install the watchdog (use --watchdog to re-enable).")
		return true, nil
	case watchdog:
		// Best effort: exclude a reconcile running in the agent right now. A
		// held lock is not fatal — the reset is idempotent and the agent
		// re-reads the state on its next attempt.
		if lock, lerr := watchdoginstall.AcquireLock(d.store.Dir); lerr == nil {
			defer lock.Release()
		}
		if err := d.store.SetOptedOut(false); err != nil {
			return false, err
		}
		if err := d.store.Reset(); err != nil {
			return false, fmt.Errorf("reset watchdog install state: %w", err)
		}
		return false, nil
	}
	if d.store.OptedOut() {
		fmt.Fprintln(out, "watchdog install skipped: opted out (use --watchdog to re-enable)")
		return true, nil
	}
	return false, nil
}

func ensureStoreDir(d watchdogFlagDeps) error {
	if d.ensureDir == nil {
		return nil
	}
	if _, err := os.Stat(d.store.Dir); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return d.ensureDir()
}
