//go:build darwin || linux

package macrelocate

import (
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

// TestDefaultDepsWireTheRealPrimitives exercises the production wiring the
// agent and watchdog both use, on the required Linux CI job: the unit tests
// above only ever see fakes, so a wiring slip (wrong predicate, swapped
// remover) would otherwise surface only in the advisory macOS job.
func TestDefaultDepsWireTheRealPrimitives(t *testing.T) {
	d := DefaultDeps(slog.New(slog.DiscardHandler))

	// VerifyLocation is the real ownership chain check.
	for _, c := range []string{"/usr/bin/id", "/bin/ls"} {
		resolved, err := filepath.EvalSymlinks(c)
		if err != nil {
			continue
		}
		if err := d.VerifyLocation(resolved); err != nil {
			t.Fatalf("VerifyLocation(%q) = %v, want a root-owned system binary accepted", resolved, err)
		}
		break
	}
	if os.Geteuid() != 0 {
		userOwned := filepath.Join(t.TempDir(), "breeze-agent")
		if err := os.WriteFile(userOwned, []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := d.VerifyLocation(userOwned); err == nil {
			t.Fatal("VerifyLocation accepted a user-owned location")
		}
	}

	// RemoveLegacyFile removes a regular file and refuses a symlink.
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "breeze-agent"), []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(dir, "breeze-agent"), filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if err := d.RemoveLegacyFile(dir, "link"); err == nil {
		t.Fatal("RemoveLegacyFile removed a symlink")
	}
	if err := d.RemoveLegacyFile(dir, "breeze-agent"); err != nil {
		t.Fatalf("RemoveLegacyFile: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(dir, "breeze-agent")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("regular file still present")
	}

	// WriteRecord is the real record writer the heartbeat reads back.
	recDir := t.TempDir()
	if err := d.WriteRecord(recDir, Record{From: "a", To: "b"}); err != nil {
		t.Fatal(err)
	}
	if r, err := ReadRecord(recDir); err != nil || r == nil || r.To != "b" {
		t.Fatalf("ReadRecord = %+v, %v", r, err)
	}

	if d.Geteuid == nil || d.Executable == nil || d.Migrate == nil || d.StartDetached == nil ||
		d.ReadFile == nil || d.Lstat == nil || d.Now == nil || d.Log == nil {
		t.Fatal("DefaultDeps left a dependency nil")
	}
}
