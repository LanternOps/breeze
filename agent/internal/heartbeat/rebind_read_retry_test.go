package heartbeat

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// #8318 review: a staged set the new process cannot read at first (a scan
// holding the file, an I/O error, an owner check that did not answer) is kept
// and read again by the tick and the source-401 path until a read succeeds;
// a confirmed set is then swapped in. It is never dropped on a read failure.
func TestRebindRetriesAStagedSetItCannotReadYet(t *testing.T) {
	cases := []struct {
		name     string
		failures int32
		err      error
		via401   bool
	}{
		{name: "one sharing violation", failures: 1, err: errors.New("being used by another process")},
		{name: "three I/O errors", failures: 3, err: errors.New("input/output error")},
		{name: "permission denied twice", failures: 2, err: fs.ErrPermission},
		{name: "owner check unanswered, driven by the source 401", failures: 2, err: errors.New("owner not verified"), via401: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRebindHarness(t)
			r.killAfter = config.RebindPhaseConfirmed
			r.drive(r.directive(rebindGoldenIntent))
			r.killAfter = ""
			set := r.staged()
			if set == nil || set.Phase != config.RebindPhaseConfirmed {
				t.Fatal("expected a confirmed set on disk")
			}

			r.restart()
			var reads atomic.Int32
			readFromDisk := rebindReadStaged
			rebindReadStaged = func(cfgFile string) (*config.RebindStagedSet, error) {
				if reads.Add(1) <= tc.failures {
					return nil, fmt.Errorf("%w: %v", config.ErrRebindStagedUnreadable, tc.err)
				}
				return readFromDisk(cfgFile)
			}
			r.h.resumeRebind()
			if !r.h.rebind.pendingOnDisk.Load() {
				t.Fatal("a staged set that could not be read is not retried (pendingOnDisk unset)")
			}
			if _, err := os.Stat(config.RebindStagedPath(r.cfgPath)); err != nil {
				t.Fatal("the unreadable staged set was removed")
			}
			if r.restarts.Load() != 0 {
				t.Fatal("swapped without reading the set")
			}

			deadline := time.Now().Add(5 * time.Second)
			for r.restarts.Load() == 0 {
				if time.Now().After(deadline) {
					t.Fatalf("no swap after %d failed reads (reads=%d)", tc.failures, reads.Load())
				}
				r.advance(rebindRetryMax)
				if tc.via401 {
					r.h.noteSourceCredentialsRejected()
				} else {
					r.h.tickRebind()
				}
				time.Sleep(20 * time.Millisecond)
			}
			if reads.Load() <= tc.failures {
				t.Fatalf("reads = %d, want more than the %d failures", reads.Load(), tc.failures)
			}
			r.assertSwapped(set)
		})
	}
}
