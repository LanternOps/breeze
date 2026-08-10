package heartbeat

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
	"github.com/breeze-rmm/agent/internal/logging"
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

// TestPromoteBackup_EmptyProbedURLDiagnosticRunsFirst pins the log-ordering
// contract: the pre-existing empty-probedURL diagnostic must run BEFORE the
// hostpolicy refusal check, not after. hostpolicy.AllowedURL("") also
// returns a "not a parseable URL" error, so with the checks in the wrong
// order an empty probedURL under a strict build silently logs the
// hostpolicy-refusal message instead of the empty-URL diagnostic — the two
// return paths are behaviourally identical (neither promotes), so this can
// only be observed on the log output, not on heartbeat state.
func TestPromoteBackup_EmptyProbedURLDiagnosticRunsFirst(t *testing.T) {
	restoreHosts := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restoreHosts()
	restoreStrict := hostpolicy.SetStrictModeForTest(true)
	defer restoreStrict()

	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })

	const primaryURL = "https://hosted-a.example"
	cfg := swapTestConfig(t, primaryURL, "")
	h := newFailoverTestHeartbeat(cfg, failoverRoundTripper(func(req *http.Request) (*http.Response, error) {
		return nil, errors.New("unexpected HTTP call: promotion must not make network requests")
	}))

	h.promoteBackupServerURL("")

	out := buf.String()
	if !strings.Contains(out, "refusing to promote empty backup server URL") {
		t.Errorf("expected the empty-probedURL diagnostic in the log, got: %s", out)
	}
	if strings.Contains(out, "refusing failover promotion to non-allowlisted host") {
		t.Errorf("empty probedURL must not fall through to the hostpolicy refusal message, got: %s", out)
	}
	if got := h.serverURL(); got != primaryURL {
		t.Fatalf("empty probedURL must never promote; primary = %q, want unchanged %q", got, primaryURL)
	}
}
