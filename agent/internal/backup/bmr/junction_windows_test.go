//go:build windows

package bmr

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
	"golang.org/x/sys/windows"
)

// plantJunction makes base\relative a junction to target. It fails rather
// than skips, so a runner that cannot create junctions does not pass these
// tests vacuously.
func plantJunction(t *testing.T, base, relative, target string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(base, relative)), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := securefs.InstallJunction(base, relative, target, 0); err != nil {
		t.Fatalf("create junction %s: %v", relative, err)
	}
}

func TestTreeHivePathRefusesJunctionsOnWindows(t *testing.T) {
	config := filepath.Join("Windows", "System32", "config")
	for _, shape := range []string{"config", "txr", "sibling-directory"} {
		t.Run(shape, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			if err := os.WriteFile(filepath.Join(other, "SYSTEM"), []byte("other"), 0o600); err != nil {
				t.Fatal(err)
			}
			if shape != "config" {
				if err := os.MkdirAll(filepath.Join(root, config), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, config, "SYSTEM"), []byte("hive"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			switch shape {
			case "config":
				plantJunction(t, root, config, other)
			case "txr":
				plantJunction(t, root, filepath.Join(config, "TxR"), other)
			case "sibling-directory":
				plantJunction(t, root, filepath.Join(config, "Journal"), other)
			}
			if got, err := TreeHivePath(root, filepath.Join(config, "SYSTEM")); err == nil {
				t.Fatalf("TreeHivePath = %q; want a refusal for a junction", got)
			}
		})
	}
}

func TestSelectOfflineHivesRefusesJunctionOnWindows(t *testing.T) {
	for _, name := range []string{"Windows", filepath.Join("Windows", "System32", "config")} {
		t.Run(name, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			plantJunction(t, root, name, other)
			staging := seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
			if _, err := selectOfflineHives(root, staging); err == nil {
				t.Fatal("expected an error for a junction in the tree")
			}
			entries, err := os.ReadDir(other)
			if err != nil || len(entries) != 0 {
				t.Fatalf("directory outside the tree changed: %v %v", entries, err)
			}
		})
	}
}

// A loaded hive and its logs are held by the registry without read sharing.
// Checking the directory for the next hive must not need to read them.
func TestTreeHivePathWithHeldSiblingOnWindows(t *testing.T) {
	config := filepath.Join("Windows", "System32", "config")
	root := t.TempDir()
	dir := filepath.Join(root, config)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"SYSTEM", "SYSTEM.LOG1", "SYSTEM.LOG2", "SOFTWARE"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("hive"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"SYSTEM", "SYSTEM.LOG1", "SYSTEM.LOG2"} {
		p, err := windows.UTF16PtrFromString(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		h, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
		if err != nil {
			t.Fatalf("hold %s: %v", name, err)
		}
		t.Cleanup(func() { _ = windows.CloseHandle(h) })
	}
	if got, err := TreeHivePath(root, filepath.Join(config, "SOFTWARE")); err != nil || got != filepath.Join(root, config, "SOFTWARE") {
		t.Fatalf("TreeHivePath(SOFTWARE) with SYSTEM held = %q, %v", got, err)
	}
}
