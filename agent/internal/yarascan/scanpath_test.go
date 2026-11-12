package yarascan

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// scanPath opens p and scans it through w.
func scanPath(w Worker, p string) ([]Match, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	return w.ScanFile(f, st.Size(), p)
}

// The worker scans, and quotes evidence from, the file it was handed, even
// when the path names different content by then.
func TestWorkerScansTheOpenFileNotThePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("replacing an open file by rename is not allowed on Windows")
	}
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker})}}
	m, _ := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, nil)
	if m == nil {
		t.Fatal("matcher unavailable")
	}
	defer m.Close()
	w, err := m.NewWorker()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()

	dir := t.TempDir()
	p := filepath.Join(dir, "a.bin")
	if err := os.WriteFile(p, []byte("xx breeze_yara_fixture_marker_7f3a xx"), 0o600); err != nil {
		t.Fatal(err)
	}
	h, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	other := filepath.Join(dir, "b.bin")
	if err := os.WriteFile(other, []byte("nothing here"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(other, p); err != nil {
		t.Fatal(err)
	}
	st, err := h.Stat()
	if err != nil {
		t.Fatal(err)
	}
	got, err := w.ScanFile(h, st.Size(), p)
	if err != nil || len(got) != 1 || len(got[0].Strings) == 0 || got[0].Strings[0].Offset != 3 {
		t.Fatalf("matches = %+v, err = %v; want the opened file's match", got, err)
	}
}
