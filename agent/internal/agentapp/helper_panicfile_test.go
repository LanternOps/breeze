package agentapp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestOpenHelperPanicFileBounded: the helper's stderr file is appended to
// (a previous crash trace survives a restart) until it passes the cap, then it
// starts afresh, so stray library stderr output cannot grow it without limit.
func TestOpenHelperPanicFileBounded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "user-helper-panic.log")

	write := func(s string) {
		t.Helper()
		f, err := openHelperPanicFile(path)
		if err != nil {
			t.Fatalf("open: %v", err)
		}
		if _, err := f.WriteString(s); err != nil {
			t.Fatalf("write: %v", err)
		}
		_ = f.Close()
	}
	read := func() string {
		t.Helper()
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		return string(b)
	}

	write("first crash\n")
	write("second crash\n")
	if got := read(); got != "first crash\nsecond crash\n" {
		t.Fatalf("under the cap the file must be appended to, got %q", got)
	}

	write(strings.Repeat("x", helperPanicFileMaxBytes))
	write("after cap\n")
	if got := read(); got != "after cap\n" {
		t.Fatalf("over the cap the file must start afresh, got %d bytes", len(got))
	}
}
