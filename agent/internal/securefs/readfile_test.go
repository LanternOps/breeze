package securefs

import (
	"io"
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
	defer f.Close()
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
