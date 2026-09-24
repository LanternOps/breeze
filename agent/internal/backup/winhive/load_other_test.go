//go:build !windows

package winhive

import "testing"

// Off Windows there is no registry: Load refuses (tests use Fake) and the
// leftover sweep finds nothing.
func TestLoadAndUnloadStale_OffWindows(t *testing.T) {
	if h, err := Load("/tmp/SYSTEM", "BRZ_x_SYSTEM"); err == nil || h != nil {
		t.Fatalf("Load = %v, %v; want nil handle and an error", h, err)
	}
	if n, err := UnloadStale("BRZ_"); n != 0 || err != nil {
		t.Fatalf("UnloadStale = %d, %v; want 0, nil", n, err)
	}
}
