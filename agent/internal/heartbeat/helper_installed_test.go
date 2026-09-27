package heartbeat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #7043: after the Breeze Helper is installed or updated, the agent refreshes
// the session broker's hash allowlist and checks the new binary is in it.

func TestRefreshBrokerAfterHelperInstall_NoBrokerIsNoop(t *testing.T) {
	h := &Heartbeat{}
	if err := h.refreshBrokerAfterHelperInstall("/nonexistent/breeze-helper"); err != nil {
		t.Fatalf("no broker: err = %v, want nil (nothing to refresh)", err)
	}
}

func TestRefreshBrokerAfterHelperInstall_AllowlistedBinaryIsAccepted(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{sessionBroker: sessionbroker.New(filepath.Join(t.TempDir(), "b.sock"), nil)}
	// The running executable is always on the broker's allowlist.
	if err := h.refreshBrokerAfterHelperInstall(exe); err != nil {
		t.Fatalf("allowlisted binary: err = %v, want nil", err)
	}
}

func TestRefreshBrokerAfterHelperInstall_BinaryOutsideAllowlistIsReported(t *testing.T) {
	stray := filepath.Join(t.TempDir(), "breeze-helper")
	if err := os.WriteFile(stray, []byte("not-on-the-allowlist"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{sessionBroker: sessionbroker.New(filepath.Join(t.TempDir(), "b.sock"), nil)}
	err := h.refreshBrokerAfterHelperInstall(stray)
	if err == nil || !strings.Contains(err.Error(), "not in the refreshed allowlist") {
		t.Fatalf("binary outside the allowlist: err = %v, want a not-in-allowlist error", err)
	}
}
