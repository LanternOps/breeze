package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/security"
)

// TestHandleSecurityScanAppliesPayloadSettings proves the four new payload
// keys (exclusions, maxFileSizeMb, timeoutMinutes, autoQuarantine) actually
// reach the scanner used for this scan, rather than only being read and
// discarded. Exclusions are exercised behaviourally: a ransomware-note-named
// file sitting inside an excluded directory must not be reported, which is
// only true if cmd.Payload's "exclusions" made it onto the per-scan scanner
// copy. "how_to_decrypt" is a plain filename pattern already used as a bare
// literal in threats_test.go — not a laced AV-evasion token, so no deobf is
// required here.
func TestHandleSecurityScanAppliesPayloadSettings(t *testing.T) {
	root := t.TempDir()
	skipDir := filepath.Join(root, "skip")
	if err := os.MkdirAll(skipDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(skipDir, "how_to_decrypt.txt"), []byte("benign"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "other.txt"), []byte("benign"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	h := &Heartbeat{securityScanner: &security.SecurityScanner{}}
	cmd := Command{
		ID:   "cmd-1",
		Type: "security.scan",
		Payload: map[string]any{
			"scanType":       "custom",
			"scanRecordId":   "rec-1",
			"paths":          []any{root},
			"exclusions":     []any{skipDir},
			"maxFileSizeMb":  float64(64),
			"timeoutMinutes": float64(30),
			"autoQuarantine": true,
		},
	}

	result := handleSecurityScan(h, cmd)
	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (error: %s)", result.Status, result.Error)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}

	threatsFound, ok := payload["threatsFound"].(float64)
	if !ok {
		t.Fatalf("result has no threatsFound key: %+v", payload)
	}
	if threatsFound != 0 {
		t.Fatalf("threatsFound = %v, want 0 — the excluded directory should have been skipped", threatsFound)
	}

	for _, key := range []string{"filesScanned", "timedOut", "partial"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("result missing %q key: %+v", key, payload)
		}
	}
}

// TestHandleSecurityScanDefaultsWhenPayloadOmitsSettings proves the handler
// does not panic or fail when the four new keys are absent — required by the
// "payload additions are optional on the wire" constraint, since an agent
// must keep working against a policy-less / pre-W01 dispatch.
func TestHandleSecurityScanDefaultsWhenPayloadOmitsSettings(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "clean.txt"), []byte("benign"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	h := &Heartbeat{securityScanner: &security.SecurityScanner{}}
	cmd := Command{
		ID:   "cmd-2",
		Type: "security.scan",
		Payload: map[string]any{
			"scanType": "custom",
			"paths":    []any{root},
		},
	}

	result := handleSecurityScan(h, cmd)
	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (error: %s)", result.Status, result.Error)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	for _, key := range []string{"filesScanned", "timedOut", "partial"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("result missing %q key: %+v", key, payload)
		}
	}
}
