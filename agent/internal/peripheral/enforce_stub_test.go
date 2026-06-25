//go:build !windows

package peripheral

import "testing"

func TestStubEnforcer_AlertOnly(t *testing.T) {
	e := NewEnforcer()
	if out := e.DisableDevice("USBSTOR\\X"); out.Applied || out.Verified {
		t.Fatalf("stub must not claim enforcement, got %+v", out)
	}
}
