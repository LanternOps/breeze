//go:build windows

package pamlifetime

import (
	"path/filepath"
	"testing"
)

func TestWindowsManagerAdvertisesLifetimeProtocolV2(t *testing.T) {
	manager := NewManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")))
	if got := manager.ProtocolVersion(); got != 2 {
		t.Fatalf("ProtocolVersion = %d, want 2", got)
	}
}
