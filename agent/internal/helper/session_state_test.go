package helper

import (
	"path/filepath"
	"testing"
)

func TestNewSessionStatePathDerivation(t *testing.T) {
	baseDir := "/tmp/breeze"
	state := newSessionState("501", baseDir)

	if got, want := state.configPath, filepath.Join(baseDir, "sessions", "501", "helper_config.yaml"); got != want {
		t.Fatalf("configPath = %q, want %q", got, want)
	}
	if got, want := state.statusPath, filepath.Join(baseDir, "sessions", "501", "helper_status.yaml"); got != want {
		t.Fatalf("statusPath = %q, want %q", got, want)
	}
}

func TestSessionStateConfigUnchanged(t *testing.T) {
	state := newSessionState("501", "/tmp/breeze")
	cfg := &Config{ShowOpenPortal: true, PortalUrl: "https://example.com"}
	if state.configUnchanged(cfg) {
		t.Fatal("nil lastConfig should not compare equal")
	}

	state.lastConfig = &Config{ShowOpenPortal: true, PortalUrl: "https://example.com"}
	if !state.configUnchanged(cfg) {
		t.Fatal("matching config should compare equal")
	}
}
