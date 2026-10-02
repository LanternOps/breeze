//go:build windows

package securefs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// On Windows every restored component must be creatable under its literal
// name; a stream separator or a trailing dot/space is refused before anything
// touches the disk.
func TestCleanRelativeRefusesInvalidWindowsNames(t *testing.T) {
	for _, rel := range []string{`a:b`, `dir\file.txt:stream`, `x::$DATA`, `dir.\file.txt`, `dir\name `} {
		if _, err := CleanRelative(rel); !errors.Is(err, ErrInvalidWindowsName) {
			t.Fatalf("CleanRelative(%q) error = %v, want ErrInvalidWindowsName", rel, err)
		}
	}
	if _, err := CleanRelative(`dir\normal.txt`); err != nil {
		t.Fatalf("CleanRelative(normal) = %v", err)
	}
}

func TestInstallFileRefusesStreamName(t *testing.T) {
	base := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, "host.txt"), []byte("host"), 0o600); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "src")
	if err := os.WriteFile(src, []byte("payload"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := InstallFile(base, "host.txt:extra", src, 0o644, time.Now(), nil)
	if !errors.Is(err, ErrInvalidWindowsName) {
		t.Fatalf("InstallFile(stream name) error = %v, want ErrInvalidWindowsName", err)
	}
	if _, statErr := os.Stat(filepath.Join(base, "host.txt:extra")); statErr == nil {
		t.Fatal("a stream was created on host.txt")
	}
	if err := InstallDir(base, `sub.`, 0, false, nil, time.Time{}); !errors.Is(err, ErrInvalidWindowsName) {
		t.Fatalf("InstallDir(trailing dot) error = %v, want ErrInvalidWindowsName", err)
	}
	if _, statErr := os.Stat(filepath.Join(base, "sub")); statErr == nil {
		t.Fatal("trailing-dot directory was created under its stripped name")
	}
}

func TestSplitWindowsComponentsValidates(t *testing.T) {
	if _, err := splitWindowsComponents(`one\two:ads\three`); !errors.Is(err, ErrInvalidWindowsName) {
		t.Fatalf("splitWindowsComponents error = %v, want ErrInvalidWindowsName", err)
	}
	got, err := splitWindowsComponents(`one\\.\two`)
	if err != nil || len(got) != 2 || got[0] != "one" || got[1] != "two" {
		t.Fatalf("splitWindowsComponents = %v, %v", got, err)
	}
}

// A drive-absolute symlink target is not a restored component: its drive
// letter keeps its ':' and the shape decision is unchanged.
func TestDriveAbsoluteUnchanged(t *testing.T) {
	if !driveAbsolute(`C:\Windows`) || driveAbsolute(`C:rel`) || driveAbsolute(`\\host\share`) {
		t.Fatal("driveAbsolute classification changed")
	}
}
