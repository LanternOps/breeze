package heartbeat

import (
	"os"
	"path/filepath"
	"testing"
)

// Custom scan roots are checked before any scanner or rule set is prepared.
// The checks look at what a root really is, so the credential file must
// exist for its name to be judged.
func TestSecurityScanChecksCustomRootsBeforeScanning(t *testing.T) {
	credential := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(credential, []byte("KEY=1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{credential, `\\fileserver\share`, "relative/folder"} {
		result := handleSecurityScan(nil, Command{Payload: map[string]any{"scanType": "custom", "paths": []any{root}}})
		if result.Status != "failed" {
			t.Errorf("%q: status=%s, want a refusal", root, result.Status)
		}
	}
}
