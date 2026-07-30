package heartbeat

import (
	"fmt"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// captureExpansionLog swaps the expansion-rejection log seam for a recorder
// and clears the latch so counts cannot inherit state from another test.
func captureExpansionLog(t *testing.T) *[]string {
	t.Helper()
	var got []string
	old := logManifestTrustExpansionLogger
	logManifestTrustExpansionLogger = func(err error) { got = append(got, err.Error()) }
	t.Cleanup(func() { logManifestTrustExpansionLogger = old })
	return &got
}

// A deployment that rotated server-side under the old additive rules now hits
// expansion rejection on EVERY heartbeat for the rest of the agent's life. The
// SECURITY line must be bounded, or it floods the shipped log stream.
func TestManifestTrustExpansionLogIsBounded(t *testing.T) {
	logged := captureExpansionLog(t)
	h := &Heartbeat{}

	err := fmt.Errorf("%w: refusing to add unseen keyId(s) deploy-b", config.ErrManifestTrustExpansionRejected)
	for i := 0; i < 100; i++ {
		h.logManifestTrustExpansionRejected(err)
	}
	if len(*logged) != 1 {
		t.Fatalf("expected 1 line for a repeating rejection, got %d", len(*logged))
	}

	// A different offered key set is a different operator problem.
	other := fmt.Errorf("%w: refusing to add unseen keyId(s) deploy-c", config.ErrManifestTrustExpansionRejected)
	h.logManifestTrustExpansionRejected(other)
	if len(*logged) != 2 {
		t.Fatalf("expected a distinct rejection to log again, got %d lines: %v", len(*logged), *logged)
	}

	// A successful pin re-arms the latch (mirrors the clear in
	// processHeartbeatResponse), so a recurrence is not swallowed forever.
	h.manifestTrustExpansionLogged.Store(nil)
	h.logManifestTrustExpansionRejected(other)
	if len(*logged) != 3 {
		t.Fatalf("expected the latch to re-arm after a successful pin, got %d lines: %v", len(*logged), *logged)
	}
}

// capturePinFailureLog swaps the catch-all pin-failure log seam for a recorder
// and clears the latch, mirroring captureExpansionLog above.
func capturePinFailureLog(t *testing.T) *[]string {
	t.Helper()
	var got []string
	old := logManifestTrustPinFailureLogger
	logManifestTrustPinFailureLogger = func(err error) { got = append(got, err.Error()) }
	t.Cleanup(func() { logManifestTrustPinFailureLogger = old })
	return &got
}

// The catch-all (non-rotation, non-expansion) pin-failure branch was the one
// sibling in processHeartbeatResponse WITHOUT a bound. Log shipping defaults to
// warn, so a control plane emitting persistently malformed trust material — a
// bad base64 pubkey, an unreadable pinned set — wrote one SHIPPED line per
// device per heartbeat, forever.
func TestManifestTrustPinFailureLogIsBounded(t *testing.T) {
	logged := capturePinFailureLog(t)
	h := &Heartbeat{}

	err := fmt.Errorf("load config: pinned manifest trust set is unreadable")
	for i := 0; i < 100; i++ {
		h.logManifestTrustPinFailed(err)
	}
	if len(*logged) != 1 {
		t.Fatalf("expected 1 line for a repeating pin failure, got %d", len(*logged))
	}

	// A different failure is a different operator problem.
	other := fmt.Errorf("load config: malformed base64 public key for keyId=deploy-b")
	h.logManifestTrustPinFailed(other)
	if len(*logged) != 2 {
		t.Fatalf("expected a distinct failure to log again, got %d lines: %v", len(*logged), *logged)
	}

	// A successful pin re-arms the latch (mirrors the clear in
	// processHeartbeatResponse alongside manifestTrustExpansionLogged).
	h.manifestTrustPinFailureLogged.Store(nil)
	h.logManifestTrustPinFailed(other)
	if len(*logged) != 3 {
		t.Fatalf("expected the latch to re-arm after a successful pin, got %d lines: %v", len(*logged), *logged)
	}
}
