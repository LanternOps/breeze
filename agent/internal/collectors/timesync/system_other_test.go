//go:build !windows

package timesync

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestNonWindowsCollectsNothing(t *testing.T) {
	dir := t.TempDir()
	if NewSystem() != nil {
		t.Fatal("non-Windows system exists")
	}
	got, err := New(dir, NewSystem()).Collect(context.Background())
	if err != nil || got != nil {
		t.Fatal(got, err)
	}
	if _, err = os.Stat(filepath.Join(dir, "timesync-state.json")); !os.IsNotExist(err) {
		t.Fatal("non-Windows state written")
	}
}
