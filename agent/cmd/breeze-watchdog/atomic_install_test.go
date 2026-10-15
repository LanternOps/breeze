//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func noTempFiles(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if matched, _ := filepath.Match(".*.new", e.Name()); matched {
			t.Errorf("leftover temp file %q in %s", e.Name(), dir)
		}
	}
}

func TestLinuxInstall_BinarySwapIsAtomic(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src-bin")
	dst := filepath.Join(dir, "breeze-watchdog")
	if err := os.WriteFile(src, []byte("NEW-BINARY"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("OLD-BINARY"), 0o755); err != nil {
		t.Fatal(err)
	}

	// (a) failure after the temp write leaves dst untouched.
	orig := atomicRename
	t.Cleanup(func() { atomicRename = orig })
	atomicRename = func(oldpath, newpath string) error { return errors.New("injected rename failure") }
	if err := installBinaryAtomically(src, dst); err == nil {
		t.Fatal("expected error when rename fails")
	}
	got, err := os.ReadFile(dst)
	if err != nil || string(got) != "OLD-BINARY" {
		t.Fatalf("dst after failed swap = %q, %v; want OLD-BINARY", got, err)
	}
	noTempFiles(t, dir) // (b) failure path

	// (c) success path.
	atomicRename = orig
	if err := installBinaryAtomically(src, dst); err != nil {
		t.Fatalf("install: %v", err)
	}
	got, _ = os.ReadFile(dst)
	if string(got) != "NEW-BINARY" {
		t.Fatalf("dst = %q, want NEW-BINARY", got)
	}
	st, _ := os.Stat(dst)
	if st.Mode().Perm() != 0o755 {
		t.Errorf("mode = %v, want 0755", st.Mode().Perm())
	}
	noTempFiles(t, dir) // (b) success path
}

func TestInstallBinaryAtomically_MissingSourceLeavesDst(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "breeze-watchdog")
	_ = os.WriteFile(dst, []byte("OLD"), 0o755)
	if err := installBinaryAtomically(filepath.Join(dir, "nope"), dst); err == nil {
		t.Fatal("expected error")
	}
	if got, _ := os.ReadFile(dst); string(got) != "OLD" {
		t.Fatalf("dst = %q", got)
	}
	noTempFiles(t, dir)
}

func TestWriteFileAtomically_ReplacesAndLeavesNoTemp(t *testing.T) {
	dir := t.TempDir()
	dst := filepath.Join(dir, "breeze-watchdog.service")
	if err := os.WriteFile(dst, []byte("old"), 0o600); err != nil {
		t.Fatal(err)
	}

	orig := atomicRename
	t.Cleanup(func() { atomicRename = orig })
	atomicRename = func(oldpath, newpath string) error { return errors.New("injected") }
	if err := writeFileAtomically(dst, []byte("new"), 0o644); err == nil {
		t.Fatal("expected error")
	}
	if got, _ := os.ReadFile(dst); string(got) != "old" {
		t.Fatalf("dst after failure = %q, want old", got)
	}
	noTempFiles(t, dir)

	atomicRename = orig
	if err := writeFileAtomically(dst, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(dst); string(got) != "new" {
		t.Fatalf("dst = %q, want new", got)
	}
	st, _ := os.Stat(dst)
	if st.Mode().Perm() != 0o644 {
		t.Errorf("mode = %v, want 0644", st.Mode().Perm())
	}
	noTempFiles(t, dir)
}
