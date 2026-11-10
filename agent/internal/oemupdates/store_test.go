package oemupdates

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func realStoreDir(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Join(base, "oem")
}

// A host that has never run a vendor update has no store directory. That has to
// read as "nothing recorded" on the real Store, or every agent start reports an
// unreadable marker and every first flash reports unreadable verifications.
func TestFreshDirStoreHoldsNothing(t *testing.T) {
	s := NewDirStore(realStoreDir(t))
	if _, err := ReadMarker(s); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("ReadMarker err = %v", err)
	}
	list, err := readPendingVerifications(s)
	if err != nil || len(list) != 0 {
		t.Fatalf("pending = %v, %v", list, err)
	}
	if err := RecoverInterrupted(Deps{Store: s}); err != nil {
		t.Fatalf("RecoverInterrupted: %v", err)
	}
}

func TestDirStoreRoundTrip(t *testing.T) {
	s := NewDirStore(realStoreDir(t))
	if _, err := s.ReadFile("run.json"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing file err = %v", err)
	}
	if err := s.WriteFile("run.json", []byte(`{"a":1}`)); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReadFile("run.json")
	if err != nil || string(got) != `{"a":1}` {
		t.Fatalf("read %q, %v", got, err)
	}
	if err := s.Remove("run.json"); err != nil {
		t.Fatal(err)
	}
	if err := s.Remove("run.json"); err != nil {
		t.Fatalf("second remove: %v", err)
	}
	if _, err := s.ReadFile("run.json"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("removed file err = %v", err)
	}
	dir, err := s.Dir("downloads")
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("Dir did not create %s", dir)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(dir); info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("downloads dir is %v, want owner-only", info.Mode().Perm())
		}
	}
}

func TestDirStoreRefusesEscapes(t *testing.T) {
	s := NewDirStore(realStoreDir(t))
	if _, err := s.Dir("../outside"); err == nil {
		t.Fatal("Dir accepted ../")
	}
	if err := s.Remove("../x"); err == nil {
		t.Fatal("Remove accepted ../")
	}
	if err := NewDirStore("relative").WriteFile("x", nil); err == nil {
		t.Fatal("a relative store wrote")
	}
}

func TestDirStoreRefusesALinkedRoot(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs privilege on windows")
	}
	base, _ := filepath.EvalSymlinks(t.TempDir())
	target := filepath.Join(base, "target")
	_ = os.Mkdir(target, 0o700)
	link := filepath.Join(base, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := NewDirStore(link).WriteFile("run.json", []byte("{}")); err == nil {
		t.Fatal("wrote through a symlinked store root")
	}
}
