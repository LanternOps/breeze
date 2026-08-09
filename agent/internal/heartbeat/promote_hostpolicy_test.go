package heartbeat

import (
	"errors"
	"net/http"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

// TestPromoteBackup_StrictRefusesNonAllowlisted is the defense-in-depth check
// for the strict build: promoteBackupServerURL must refuse to swap in a
// non-allowlisted host and leave the current primary untouched, even though
// Task 4 already gated ingestion of the backup_server_url that reaches here.
func TestPromoteBackup_StrictRefusesNonAllowlisted(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	const primaryURL = "https://hosted-a.example"
	cfg := swapTestConfig(t, primaryURL, "")
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected HTTP call: promotion must not make network requests")
	}))

	h.promoteBackupServerURL("https://attacker.es")

	if got := h.serverURL(); got != primaryURL {
		t.Fatalf("strict build must not promote non-allowlisted host; primary now %q, want unchanged %q", got, primaryURL)
	}
}

// TestPromoteBackup_GapPromotesNormally proves the gap build (allowlist set,
// strict mode off) does not degrade existing-fleet failover: a probed backup
// that isn't on the allowlist is still promoted, matching pre-hostpolicy
// behavior.
func TestPromoteBackup_GapPromotesNormally(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()

	const (
		primaryURL = "https://hosted-a.example"
		backupURL  = "https://attacker.es" // not allowlisted; gap build must still promote it
	)
	cfg := swapTestConfig(t, primaryURL, backupURL)
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected HTTP call: promotion must not make network requests")
	}))

	h.promoteBackupServerURL(backupURL)

	if got := h.serverURL(); got != backupURL {
		t.Fatalf("gap build must promote normally (no degradation); primary = %q, want %q", got, backupURL)
	}
}
