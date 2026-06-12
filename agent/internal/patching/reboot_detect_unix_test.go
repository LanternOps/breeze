package patching

import (
	"os"
	"testing"
	"time"
)

func TestDetectPendingRebootLinux(t *testing.T) {
	marker := linuxRebootMarkers[0]
	statHit := func(p string) (os.FileInfo, error) {
		if p == marker {
			return nil, nil // FileInfo value is never inspected
		}
		return nil, os.ErrNotExist
	}
	statMiss := func(string) (os.FileInfo, error) { return nil, os.ErrNotExist }

	tests := []struct {
		name string
		stat func(string) (os.FileInfo, error)
		nr   func() (bool, bool)
		want bool
	}{
		{"marker file present", statHit, func() (bool, bool) { return false, false }, true},
		{"needs-restarting reports reboot needed", statMiss, func() (bool, bool) { return true, true }, true},
		{"needs-restarting reports clean", statMiss, func() (bool, bool) { return false, true }, false},
		{"no signal available", statMiss, func() (bool, bool) { return false, false }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, reasons := detectPendingRebootLinux(tt.stat, tt.nr)
			if got != tt.want {
				t.Errorf("got %v, want %v (reasons: %v)", got, tt.want, reasons)
			}
			if got && len(reasons) == 0 {
				t.Error("expected at least one reason when reboot is pending")
			}
			if !got && len(reasons) != 0 {
				t.Errorf("expected no reasons when not pending, got %v", reasons)
			}
		})
	}
}

func TestNeedsRestartingCache(t *testing.T) {
	calls := 0
	run := func() (bool, bool) { calls++; return true, true }

	c := &nrCache{ttl: time.Hour, run: run}
	if got, ok := c.get(); !got || !ok {
		t.Fatalf("first get: got (%v,%v), want (true,true)", got, ok)
	}
	c.get()
	if calls != 1 {
		t.Errorf("expected 1 underlying call while cached, got %d", calls)
	}

	// A cache whose entry has already expired must re-run.
	expired := &nrCache{ttl: time.Hour, at: time.Now().Add(-2 * time.Hour), run: run}
	expired.get()
	if calls != 2 {
		t.Errorf("expected refresh after TTL expiry, got %d calls", calls)
	}
}
