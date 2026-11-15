package securefs

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCopyFilePreservesSource(t *testing.T) {
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	if _, err := CopyFile(root, "copy", source, 0o600, time.Time{}, nil); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{source, filepath.Join(root, "copy")} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != "content" {
			t.Fatalf("%s: %q %v", path, got, err)
		}
	}
	if _, err := InstallFile(root, "installed", source, 0o600, time.Time{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("install source: %v", err)
	}
}

func TestCopyFileFromRootSourceBoundary(t *testing.T) {
	for _, shape := range []string{"regular", "directory-link", "file-link"} {
		t.Run(shape, func(t *testing.T) {
			sourceRoot, destination, other := t.TempDir(), t.TempDir(), t.TempDir()
			if err := os.MkdirAll(filepath.Join(sourceRoot, "inputs"), 0o700); err != nil {
				t.Fatal(err)
			}
			source := filepath.Join(sourceRoot, "inputs", "file")
			if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(other, "file"), []byte("other"), 0o600); err != nil {
				t.Fatal(err)
			}
			if shape != "regular" {
				link, target := source, filepath.Join(other, "file")
				if shape == "directory-link" {
					link, target = filepath.Dir(source), other
				}
				if err := os.RemoveAll(link); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, link); err != nil {
					t.Skip(err)
				}
			}
			_, err := CopyFileFromRoot(destination, "file", sourceRoot, filepath.Join("inputs", "file"), 0o600, time.Time{}, nil)
			if shape == "regular" {
				if err != nil {
					t.Fatal(err)
				}
				for _, path := range []string{source, filepath.Join(destination, "file")} {
					got, err := os.ReadFile(path)
					if err != nil || string(got) != "content" {
						t.Fatalf("copy result: %q %v", got, err)
					}
				}
			} else {
				if err == nil {
					t.Fatal("expected source boundary error")
				}
				if _, err := os.Stat(filepath.Join(destination, "file")); !os.IsNotExist(err) {
					t.Fatalf("unexpected result: %v", err)
				}
			}
		})
	}
}
