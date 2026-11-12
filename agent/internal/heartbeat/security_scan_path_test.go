package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
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

// Quarantining into the agent's own default quarantine folder is allowed,
// even though that folder sits inside the agent's protected data folder.
func TestThreatQuarantineUsesTheAgentDefaultFolder(t *testing.T) {
	workspace := t.TempDir()
	if err := config.SecureUserWorkspace(workspace); err != nil {
		t.Skipf("cannot register a workspace here: %v", err)
	}
	t.Cleanup(config.ResetUserWorkspaceForTest)

	threat := filepath.Join(t.TempDir(), "sample.bin")
	if err := os.WriteFile(threat, []byte("sample"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := handleSecurityThreatQuarantine(nil, Command{Payload: map[string]any{"path": threat, "name": "test"}})
	if result.Status != "completed" {
		t.Fatalf("status=%s code=%q error=%q", result.Status, result.ErrorCode, result.Error)
	}
	if _, err := os.Stat(threat); !os.IsNotExist(err) {
		t.Fatalf("the file was not moved into quarantine (stat err=%v)", err)
	}
}

// A quarantine folder named by the caller is still checked.
func TestThreatQuarantineChecksACallerChosenFolder(t *testing.T) {
	cfg := t.TempDir()
	restore := config.SetConfigDirForTest(cfg)
	t.Cleanup(restore)
	threat := filepath.Join(t.TempDir(), "sample.bin")
	if err := os.WriteFile(threat, []byte("sample"), 0o600); err != nil {
		t.Fatal(err)
	}
	result := handleSecurityThreatQuarantine(nil, Command{Payload: map[string]any{"path": threat, "quarantineDir": filepath.Join(cfg, "q")}})
	if result.Status != "failed" {
		t.Fatalf("status=%s, want a refusal", result.Status)
	}
}

// A payload in the agent's own quarantine folder can be restored, even though
// that folder sits inside the agent's protected data folder.
func TestThreatRestoreFromTheAgentDefaultFolder(t *testing.T) {
	workspace := t.TempDir()
	if err := config.SecureUserWorkspace(workspace); err != nil {
		t.Skipf("cannot register a workspace here: %v", err)
	}
	t.Cleanup(config.ResetUserWorkspaceForTest)

	original := filepath.Join(t.TempDir(), "sample.bin")
	if err := os.WriteFile(original, []byte("sample"), 0o600); err != nil {
		t.Fatal(err)
	}
	q := handleSecurityThreatQuarantine(nil, Command{Payload: map[string]any{"path": original, "name": "test"}})
	if q.Status != "completed" {
		t.Fatalf("quarantine: status=%s error=%q", q.Status, q.Error)
	}
	var out struct {
		QuarantinedTo string `json:"quarantinedTo"`
	}
	if err := json.Unmarshal([]byte(q.Stdout), &out); err != nil || out.QuarantinedTo == "" {
		t.Fatalf("quarantine result: %q (%v)", q.Stdout, err)
	}
	r := handleSecurityThreatRestore(nil, Command{Payload: map[string]any{"quarantinedPath": out.QuarantinedTo, "originalPath": original}})
	if r.Status != "completed" {
		t.Fatalf("restore: status=%s code=%q error=%q", r.Status, r.ErrorCode, r.Error)
	}
	if got, err := os.ReadFile(original); err != nil || string(got) != "sample" {
		t.Fatalf("restored content = %q (err=%v)", got, err)
	}
}
