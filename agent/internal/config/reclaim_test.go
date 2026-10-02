package config

import (
	"path/filepath"
	"testing"
)

// TestReclaimConfigDirMissingIsANoOp: nothing to take back before the first
// install.
func TestReclaimConfigDirMissingIsANoOp(t *testing.T) {
	if err := reclaimConfigDir(filepath.Join(t.TempDir(), "absent"), true); err != nil {
		t.Fatalf("reclaimConfigDir on a missing dir: %v", err)
	}
}
