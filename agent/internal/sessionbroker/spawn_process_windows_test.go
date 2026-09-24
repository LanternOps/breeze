//go:build windows

package sessionbroker

import (
	"errors"
	"path/filepath"
	"testing"
)

// #6872: cmd.exe /c start "" "<missing>" used to report success with cmd.exe's
// PID; the missing file only surfaced as a "crash" 30s later, and Windows
// showed the user a "cannot find" dialog on every retry. Stat first.
func TestSpawnProcessInSessionWithArgsMissingBinary(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "breeze-helper.exe")

	err := SpawnProcessInSessionWithArgs(missing, []string{"--config", "x"}, 1)

	if !errors.Is(err, ErrBinaryMissing) {
		t.Fatalf("err = %v, want ErrBinaryMissing", err)
	}
}
