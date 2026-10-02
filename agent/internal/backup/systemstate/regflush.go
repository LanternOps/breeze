package systemstate

import (
	"errors"
	"fmt"
	"log/slog"
	"time"
)

// ---------------------------------------------------------------------------
// Registry flush before a VSS snapshot (#7367)
//
// A shadow copy holds only what the configuration manager has already written
// to the hive files and their .LOG1/.LOG2 logs. Registry changes still held in
// memory are not in the snapshot, so they are missing from the captured hives
// and from a machine rebuilt from the backup (lab: a service created 24 s
// before the snapshot was absent from SYSTEM even with its logs replayed).
// FlushRegistryHives asks the configuration manager to write every loaded
// on-disk hive out before a snapshot is taken.
//
// Portable (no build tag) so the target bookkeeping runs on every GOOS; the
// Windows RegFlushKey call lives in regflush_windows.go and every other GOOS
// has no registry to flush.
// ---------------------------------------------------------------------------

// flushHivesBeforeSnapshot is the seam the registry step's own system-volume
// snapshot calls first (see snapshotSystemVolumeForHives).
var flushHivesBeforeSnapshot = FlushRegistryHives

// hiveFlushTarget names one loaded hive by its mount point: Root is "HKLM" or
// "HKU", Path the subkey the hive is loaded at. A Required hive (the four a
// bootable rebuild needs) that is not loaded is reported; any other is
// skipped quietly when it is not loaded.
type hiveFlushTarget struct {
	Root     string
	Path     string
	Required bool
}

func (t hiveFlushTarget) String() string { return t.Root + `\` + t.Path }

// errHiveNotLoaded is what a flushOne returns when the target's key does not
// exist, i.e. no hive is loaded there (an unloaded COMPONENTS hive, a user
// who logged off between enumeration and the flush).
var errHiveNotLoaded = errors.New("hive not loaded")

// flushHiveTargets flushes every target, never stopping at a failure: a hive
// that could not be flushed must not leave the others unflushed. It returns
// how many were flushed and every failure, joined.
func flushHiveTargets(targets []hiveFlushTarget, flushOne func(hiveFlushTarget) error) (int, error) {
	flushed := 0
	var errs []error
	for _, t := range targets {
		err := flushOne(t)
		switch {
		case err == nil:
			flushed++
		case errors.Is(err, errHiveNotLoaded) && !t.Required:
			// Nothing loaded there, nothing to lose.
		default:
			errs = append(errs, fmt.Errorf("%s: %w", t, err))
		}
	}
	return flushed, errors.Join(errs...)
}

// flushLoadedHives is the platform flush (regflush_windows.go /
// regflush_other.go), a var so tests can make it slow or fail.
var flushLoadedHives = flushLoadedHivesPlatform

// flushTimeout bounds how long a backup waits for the flush. RegFlushKey is
// synchronous disk I/O with no cancellation; a flush that has not returned by
// then is left to finish in the background and the snapshot goes ahead, so a
// stuck flush costs the capture its freshness, never the backup.
var flushTimeout = 60 * time.Second

type flushResult struct {
	flushed int
	err     error
}

// FlushRegistryHives writes the loaded registry hives' in-memory changes to
// disk so a VSS snapshot taken next contains them. It is best effort and
// never fails the caller: a hive it cannot flush is captured as the snapshot
// finds it, which is what every backup got before this flush existed. Every
// failure, and a flush still running after flushTimeout, is logged as a
// warning.
func FlushRegistryHives() {
	start := time.Now()
	flush := flushLoadedHives         // read once: a timed-out goroutine outlives the caller
	done := make(chan flushResult, 1) // buffered: a timed-out flush never blocks on send
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- flushResult{err: fmt.Errorf("panic: %v", r)}
			}
		}()
		n, err := flush()
		done <- flushResult{flushed: n, err: err}
	}()
	timer := time.NewTimer(flushTimeout)
	defer timer.Stop()
	var res flushResult
	select {
	case res = <-done:
	case <-timer.C:
		slog.Warn("systemstate: registry flush before the VSS snapshot did not finish in time, taking the snapshot anyway; recent registry changes may be missing from the backup",
			"timeout", flushTimeout.String())
		return
	}
	elapsed := time.Since(start).Milliseconds()
	if res.err != nil {
		slog.Warn("systemstate: could not flush every registry hive before the VSS snapshot; changes still in memory for those hives may be missing from the backup",
			"flushed", res.flushed, "elapsedMs", elapsed, "error", res.err.Error())
		return
	}
	if res.flushed > 0 {
		slog.Info("systemstate: flushed registry hives before the VSS snapshot", "flushed", res.flushed, "elapsedMs", elapsed)
	}
}
