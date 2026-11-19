package securefs

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestOpenFileReadsARegularFile(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "d"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "d", "f.txt"), []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := OpenFile(base, filepath.Join("d", "f.txt"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	got, _ := io.ReadAll(f)
	if string(got) != "content" {
		t.Fatalf("got %q", got)
	}
}

func TestOpenFileRefusesLinksAndEscapes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege the test runner may lack")
	}
	base := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(base, "final-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(base, "dir-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(base, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, rel := range []string{"final-link", filepath.Join("dir-link", "secret"), filepath.Join("..", "x"), "dir", "missing"} {
		if f, err := OpenFile(base, rel); err == nil {
			_ = f.Close()
			t.Fatalf("OpenFile(%q) succeeded", rel)
		}
	}
}

// Callers branch on absence: "no state file yet" is the normal first run, and
// anything else is treated as unreadable state. Every platform has to report it
// the same way, whichever component is the missing one.
func TestOpenFileReportsAbsenceAsNotExist(t *testing.T) {
	base := t.TempDir()
	for name, tc := range map[string]struct{ base, rel string }{
		"missing file":          {base, "missing"},
		"missing subdirectory":  {base, filepath.Join("no-such-dir", "missing")},
		"missing base":          {filepath.Join(base, "no-such-base"), "missing"},
		"missing base and tree": {filepath.Join(base, "a", "b"), filepath.Join("c", "missing")},
	} {
		t.Run(name, func(t *testing.T) {
			f, err := OpenFile(tc.base, tc.rel)
			if err == nil {
				_ = f.Close()
				t.Fatal("OpenFile succeeded")
			}
			if !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("err = %v, want fs.ErrNotExist", err)
			}
		})
	}
}

// Only absence may read as absence. A caller treats fs.ErrNotExist as "nothing
// there", so a refusal has to stay a refusal.
func TestOpenFileRefusalsAreNotReportedAsAbsence(t *testing.T) {
	base := t.TempDir()
	if err := os.Mkdir(filepath.Join(base, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(base, "file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, rel := range map[string]string{
		"a directory":       "dir",
		"through a file":    filepath.Join("file", "child"),
		"escaping the base": filepath.Join("..", "x"),
	} {
		t.Run(name, func(t *testing.T) {
			f, err := OpenFile(base, rel)
			if err == nil {
				_ = f.Close()
				t.Fatal("OpenFile succeeded")
			}
			if errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("err = %v reads as absence", err)
			}
		})
	}
}
