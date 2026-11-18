//go:build linux

package collectors

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type spawnRecorder struct {
	mu    sync.Mutex
	calls []string
}

func (r *spawnRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

// recordCollectorCommands counts collector subprocess spawns for the test.
func recordCollectorCommands(t *testing.T) *spawnRecorder {
	t.Helper()
	rec := &spawnRecorder{}
	hook := func(name string, args []string) {
		rec.mu.Lock()
		rec.calls = append(rec.calls, name+" "+strings.Join(args, " "))
		rec.mu.Unlock()
	}
	prev := collectorCommandHook.Swap(&hook)
	t.Cleanup(func() { collectorCommandHook.Store(prev) })
	return rec
}

// useFakeBinary puts a shell script named name on an otherwise empty PATH.
func useFakeBinary(t *testing.T, name, script string) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
}
