package bmr

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestTreeHivePath(t *testing.T) {
	config := filepath.Join("Windows", "System32", "config")
	for _, shape := range []string{"regular", "missing", "directory-link", "file-link", "directory"} {
		t.Run(shape, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			if err := os.WriteFile(filepath.Join(other, "SYSTEM"), []byte("other"), 0o600); err != nil {
				t.Fatal(err)
			}
			dir := filepath.Join(root, config)
			if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
				t.Fatal(err)
			}
			switch shape {
			case "directory-link":
				if err := os.Symlink(other, dir); err != nil {
					t.Skip(err)
				}
			default:
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			switch shape {
			case "regular":
				if err := os.WriteFile(filepath.Join(dir, "SYSTEM"), []byte("hive"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "file-link":
				if err := os.Symlink(filepath.Join(other, "SYSTEM"), filepath.Join(dir, "SYSTEM")); err != nil {
					t.Skip(err)
				}
			case "directory":
				if err := os.Mkdir(filepath.Join(dir, "SYSTEM"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			got, err := TreeHivePath(root, filepath.Join(config, "SYSTEM"))
			switch shape {
			case "regular":
				if err != nil || got != filepath.Join(root, config, "SYSTEM") {
					t.Fatalf("TreeHivePath = %q, %v", got, err)
				}
			case "missing":
				if !errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("missing hive: %v, want fs.ErrNotExist", err)
				}
			default:
				if err == nil || errors.Is(err, fs.ErrNotExist) {
					t.Fatalf("TreeHivePath = %q, %v; want a refusal", got, err)
				}
			}
		})
	}
	if _, err := TreeHivePath(t.TempDir(), filepath.Join("..", "SYSTEM")); err == nil {
		t.Fatal("expected a refusal for a relative path that leaves the base")
	}
}

// The registry also opens the hive's transaction logs and the TxR files next
// to it when loading. Any link in the hive's directory or in TxR is refused,
// whatever its name.
func TestTreeHivePathCompanionFiles(t *testing.T) {
	config := filepath.Join("Windows", "System32", "config")
	for _, shape := range []string{"regular", "log-file-link", "log-directory-link", "log-lowercase-link", "txr-directory-link", "txr-file-link", "other-hive-link", "unrelated-link", "folded-name-link"} {
		t.Run(shape, func(t *testing.T) {
			root, other := t.TempDir(), t.TempDir()
			dir := filepath.Join(root, config)
			if err := os.MkdirAll(filepath.Join(dir, "TxR"), 0o755); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"SYSTEM", "SYSTEM.LOG2", "SOFTWARE.LOG1", filepath.Join("TxR", "{0}.TxR.blf")} {
				if err := os.WriteFile(filepath.Join(dir, name), []byte("hive"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(other, "file"), []byte("keep"), 0o600); err != nil {
				t.Fatal(err)
			}
			link, target := "", ""
			switch shape {
			case "log-file-link":
				link, target = filepath.Join(dir, "SYSTEM.LOG1"), filepath.Join(other, "file")
			case "log-directory-link":
				link, target = filepath.Join(dir, "SYSTEM.LOG1"), other
			case "log-lowercase-link":
				link, target = filepath.Join(dir, "system.log"), filepath.Join(other, "file")
			case "txr-directory-link":
				if err := os.RemoveAll(filepath.Join(dir, "TxR")); err != nil {
					t.Fatal(err)
				}
				link, target = filepath.Join(dir, "TxR"), other
			case "txr-file-link":
				link, target = filepath.Join(dir, "TxR", "{0}.TxR.0.regtrans-ms"), filepath.Join(other, "file")
			case "other-hive-link":
				link, target = filepath.Join(dir, "SOFTWARE.LOG2"), filepath.Join(other, "file")
			case "unrelated-link":
				link, target = filepath.Join(dir, "journal"), other
			case "folded-name-link":
				link, target = filepath.Join(dir, "\u017fYSTEM.LOG1"), filepath.Join(other, "file")
			}
			if link != "" {
				if err := os.Symlink(target, link); err != nil {
					t.Skip(err)
				}
			}
			got, err := TreeHivePath(root, filepath.Join(config, "SYSTEM"))
			if shape == "regular" {
				if err != nil || got != filepath.Join(root, config, "SYSTEM") {
					t.Fatalf("TreeHivePath = %q, %v", got, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("TreeHivePath = %q; want a refusal for a linked companion file", got)
			}
		})
	}
}
