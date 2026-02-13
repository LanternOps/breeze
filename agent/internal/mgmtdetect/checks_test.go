package mgmtdetect

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCheckFileExists(t *testing.T) {
	tmp := filepath.Join(t.TempDir(), "testfile")
	if err := os.WriteFile(tmp, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}

	snap, _ := newProcessSnapshot()
	d := &checkDispatcher{processSnap: snap}

	if !d.evaluate(Check{Type: CheckFileExists, Value: tmp}) {
		t.Error("should find existing file")
	}
	if d.evaluate(Check{Type: CheckFileExists, Value: "/nonexistent/path/xyz"}) {
		t.Error("should not find nonexistent file")
	}
}
