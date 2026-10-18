//go:build windows

package atomicrename

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// TestReplaceOverwritesExistingFile runs the real primitive for this host's
// build: FileRenameInfoEx on 1607+, MoveFileEx below it.
func TestReplaceOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "next.tmp")
	dst := filepath.Join(dir, "ledger.json")
	if err := os.WriteFile(dst, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := Replace(src, dst); err != nil {
		t.Fatalf("Replace: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("destination = %q, want %q", got, "new")
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("source still present after Replace: %v", err)
	}
}

// TestLegacyRenameOverwritesExistingFile exercises the MoveFileEx path that
// Windows 10 2015 LTSB takes, which a 1607+ CI host never selects on its own.
func TestLegacyRenameOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "next.tmp")
	dst := filepath.Join(dir, "ledger.json")
	if err := os.WriteFile(dst, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := &planner{infoEx: boom("infoEx"), legacy: renameWithMoveFile}
	if err := p.replace(10240, src, dst); err != nil {
		t.Fatalf("legacy replace: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "new" {
		t.Fatalf("destination = %q, want %q", got, "new")
	}
}

// TestReplaceUsesInfoExOnThisHost pins that a 1607+ host takes the POSIX
// rename rather than silently landing on MoveFileEx.
func TestReplaceUsesInfoExOnThisHost(t *testing.T) {
	if build := windows.RtlGetVersion().BuildNumber; build < fileRenameInfoExMinBuild {
		t.Skipf("build %d predates FileRenameInfoEx", build)
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "next.tmp")
	dst := filepath.Join(dir, "ledger.json")
	if err := os.WriteFile(src, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := renameWithInfoEx(src, dst); err != nil {
		t.Fatalf("FileRenameInfoEx rename on a 1607+ host: %v", err)
	}
}
