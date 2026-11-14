//go:build windows

package securefs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// The NT status for a missing name must satisfy errors.Is(err,
// fs.ErrNotExist) for StatFile as it does for OpenFile, while a junction on
// the path, live or dangling, stays a refusal and never reads as absence.
func TestStatFileWindowsAbsenceAndJunctions(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "config"), 0o755); err != nil {
		t.Fatal(err)
	}

	for name, rel := range map[string]string{
		"missing file":         filepath.Join("config", "SYSTEM"),
		"missing intermediate": filepath.Join("Windows", "System32", "config", "SYSTEM"),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := StatFile(base, rel)
			if !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("err = %v, want fs.ErrNotExist", err)
			}
		})
	}

	live := t.TempDir()
	mkJunction(t, filepath.Join(base, "live"), live)
	gone := filepath.Join(t.TempDir(), "gone")
	if err := os.Mkdir(gone, 0o755); err != nil {
		t.Fatal(err)
	}
	mkJunction(t, filepath.Join(base, "dangling"), gone)
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}
	for name, rel := range map[string]string{
		"missing file beneath a junction":          filepath.Join("live", "SYSTEM"),
		"missing file beneath a dangling junction": filepath.Join("dangling", "SYSTEM"),
		"a dangling junction itself":               "dangling",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := StatFile(base, rel)
			if err == nil {
				t.Fatal("StatFile succeeded")
			}
			if errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("err = %v reads as absence", err)
			}
		})
	}
}
