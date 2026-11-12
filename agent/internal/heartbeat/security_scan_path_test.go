package heartbeat

import (
	"path/filepath"
	"testing"
)

// Custom scan roots are checked before any scanner or rule set is prepared.
func TestSecurityScanChecksCustomRootsBeforeScanning(t *testing.T) {
	for _, root := range []string{filepath.Join(t.TempDir(), ".env"), `\\fileserver\share`, "relative/folder"} {
		result := handleSecurityScan(nil, Command{Payload: map[string]any{"scanType": "custom", "paths": []any{root}}})
		if result.Status != "failed" {
			t.Errorf("%q: status=%s, want a refusal", root, result.Status)
		}
	}
}
