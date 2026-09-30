package logging

import (
	"log/slog"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// Concurrent set_log_level commands must leave a well-formed file that
// matches the in-memory override (the last command wins in both places).
func TestConcurrentApplyLeavesConsistentFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	shipper := installTestShipper(t, slog.LevelWarn)
	shipper.overridePath = path

	levels := []string{"debug", "info", "warn", "error"}
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			st, err := ApplyShipperLevelOverride(levels[i%len(levels)], time.Duration(i+1)*time.Minute)
			if err != nil || !st.Persisted {
				t.Errorf("apply %d: err=%v persisted=%v (%s)", i, err, st.Persisted, st.PersistError)
			}
		}(i)
	}
	wg.Wait()

	o, ok, err := ReadLevelOverride(path, time.Now())
	if err != nil || !ok {
		t.Fatalf("override file unreadable after concurrent writes: ok=%v err=%v", ok, err)
	}
	shipper.mu.RLock()
	memLevel, memExpiry := shipper.overrideLevel, shipper.overrideExpiresAt
	shipper.mu.RUnlock()
	if parseLevel(o.Level) != memLevel || !o.ExpiresAt.Equal(memExpiry) {
		t.Fatalf("file (%s, %v) disagrees with memory (%v, %v)", o.Level, o.ExpiresAt, memLevel, memExpiry)
	}
}
