//go:build windows

package bmr

import (
	"errors"
	"testing"
)

// The Windows restorer never applies system state to the live system: a
// bmr_recover restores files only, and a bare-metal rebuild applies the
// state offline (RestoreSystemStateOfflineWindows).
func TestWindowsRestorer_NeverAppliesLiveSystemState(t *testing.T) {
	calls := countExecSeam(t)
	r := newRestorer()
	if err := r.RestoreSystemState(t.TempDir()); !errors.Is(err, errWindowsLiveSystemState) {
		t.Fatalf("RestoreSystemState err = %v, want errWindowsLiveSystemState", err)
	}
	if n, err := r.InjectDrivers(t.TempDir()); n != 0 || !errors.Is(err, errWindowsLiveSystemState) {
		t.Fatalf("InjectDrivers = %d, %v", n, err)
	}
	if len(*calls) != 0 {
		t.Fatalf("commands ran: %v", *calls)
	}
}
