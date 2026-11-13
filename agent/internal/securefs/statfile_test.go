package securefs

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

// Callers branch on absence: a hive missing from a restored tree selects the
// staged copy, while any other failure stops the restore. Every platform has
// to report a missing file the same way, whichever component is the missing
// one.
func TestStatFileReportsAbsenceAsNotExist(t *testing.T) {
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "present"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, tc := range map[string]struct{ base, rel string }{
		"missing file":                  {base, "missing"},
		"missing file in a present dir": {base, filepath.Join("present", "missing")},
		"missing subdirectory":          {base, filepath.Join("no-such-dir", "missing")},
		"missing nested subdirectories": {base, filepath.Join("present", "a", "b", "missing")},
		"missing base":                  {filepath.Join(base, "no-such-base"), "missing"},
		"missing base and tree":         {filepath.Join(base, "a", "b"), filepath.Join("c", "missing")},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := StatFile(tc.base, tc.rel)
			if err == nil {
				t.Fatal("StatFile succeeded")
			}
			if !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("err = %v, want fs.ErrNotExist", err)
			}
		})
	}
}

// Only absence may read as absence: a refusal has to stay a refusal.
func TestStatFileRefusalsAreNotReportedAsAbsence(t *testing.T) {
	base := t.TempDir()
	if err := os.WriteFile(filepath.Join(base, "file"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for name, rel := range map[string]string{
		"through a file":    filepath.Join("file", "child"),
		"escaping the base": filepath.Join("..", "x"),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := StatFile(base, rel)
			if err == nil {
				t.Fatal("StatFile succeeded")
			}
			if errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("err = %v reads as absence", err)
			}
		})
	}
}
