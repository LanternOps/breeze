//go:build !windows

package securefs

import (
	"errors"
	"testing"
)

// A Windows snapshot restored on a non-Windows host cannot recreate its
// junctions. The caller reports that; it must not be mistaken for an I/O error.
func TestInstallJunction_UnsupportedOffWindows(t *testing.T) {
	_, err := InstallJunction(t.TempDir(), "My Music", `C:\Users\a\Music`, 0)
	if !errors.Is(err, ErrJunctionUnsupported) {
		t.Fatalf("err = %v, want ErrJunctionUnsupported", err)
	}
}
