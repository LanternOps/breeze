package bmr

import (
	"os"
	"path/filepath"
	"testing"
)

// The hive fallback writes into <root>\Windows\System32\config. A link in the
// restored tree or in the staged artifacts must not move that work outside
// the tree or read hive content from outside the staging directory.

func TestOfflineHiveDirectoryBoundary(t *testing.T) {
	for _, name := range []string{"Windows", filepath.Join("Windows", "System32"), filepath.Join("Windows", "System32", "config")} {
		t.Run(name, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			if err := os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(other, filepath.Join(root, name)); err != nil {
				t.Skip(err)
			}
			staging := seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
			if _, err := selectOfflineHives(root, staging); err == nil {
				t.Fatal("expected an error for a directory outside the tree")
			}
			entries, err := os.ReadDir(other)
			if err != nil || len(entries) != 0 {
				t.Fatalf("directory outside the tree changed: %v %v", entries, err)
			}
		})
	}
}

func TestOfflineHiveTemporaryEntry(t *testing.T) {
	root := seedTree(t, "SOFTWARE", "SAM", "SECURITY")
	other := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(other, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(other, filepath.Join(root, "Windows", "System32", "config", "SYSTEM.brz-fallback-tmp")); err != nil {
		t.Skip(err)
	}
	staging := seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
	if _, err := selectOfflineHives(root, staging); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(other)
	if err != nil || string(got) != "keep" {
		t.Fatalf("file outside the tree changed: %q %v", got, err)
	}
	got, err = os.ReadFile(filepath.Join(root, "Windows", "System32", "config", "SYSTEM"))
	if err != nil || string(got) != "artifact-SYSTEM" {
		t.Fatalf("SYSTEM: %q %v", got, err)
	}
}

func TestOfflineHiveArtifactSourceBoundary(t *testing.T) {
	for _, shape := range []string{"directory", "file"} {
		t.Run(shape, func(t *testing.T) {
			root := seedTree(t, "SOFTWARE", "SAM", "SECURITY")
			staging := seedArtifacts(t, "SYSTEM", "SOFTWARE", "SAM", "SECURITY")
			other := t.TempDir()
			for _, hive := range offlineRequiredHives {
				if err := os.WriteFile(filepath.Join(other, hive), []byte("other"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			link, target := filepath.Join(staging, "registry"), other
			if shape == "file" {
				link, target = filepath.Join(link, "SYSTEM"), filepath.Join(other, "SYSTEM")
			}
			if err := os.RemoveAll(link); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, link); err != nil {
				t.Skip(err)
			}
			if _, err := selectOfflineHives(root, staging); err == nil {
				t.Fatal("expected an error for a staged artifact outside the staging directory")
			}
			if _, err := os.Lstat(filepath.Join(root, "Windows", "System32", "config", "SYSTEM")); !os.IsNotExist(err) {
				t.Fatalf("hive installed from outside the staging directory: %v", err)
			}
		})
	}
}
