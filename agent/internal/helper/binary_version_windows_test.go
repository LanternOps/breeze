//go:build windows

package helper

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/versionpolicy"
)

// Exercises the real Win32 version-resource path against a system DLL that
// always carries a VS_FIXEDFILEINFO.
func TestReadBinaryVersionWindowsSystemDLL(t *testing.T) {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	v, err := readBinaryVersion(filepath.Join(root, "System32", "kernel32.dll"))
	if err != nil {
		t.Fatalf("readBinaryVersion(kernel32.dll): %v", err)
	}
	if _, ok := versionpolicy.Normalize(v); !ok {
		t.Fatalf("readBinaryVersion returned %q, not a three-part SemVer", v)
	}
}

func TestReadBinaryVersionWindowsMissingFile(t *testing.T) {
	if _, err := readBinaryVersion(filepath.Join(t.TempDir(), "absent.exe")); err == nil {
		t.Fatal("expected an error for a missing binary")
	}
}
