package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// TestDoUpdateWatchdogFollowsFailoverBaseURLPromotion is the #2478 regression
// guard for the watchdog binary updater. doUpdateWatchdog (and its identically
// wired sibling doUpdateAgent) must resolve the control-plane URL from the live
// provider — the FailoverClient's BaseURL — at download time, NOT from the
// cfg.ServerURL copy captured at startup. Before the #2478 fix the updater built
// updater.Config{ServerURL: cfg.ServerURL} and therefore kept downloading from
// the dead primary even after the FailoverClient had retargeted itself to the
// promoted backup via SetBaseURL during a failover window.
//
// doUpdateWatchdog is used (rather than doUpdateAgent) because it derives its
// BinaryPath from os.Executable() — the test binary, in a writable temp dir — so
// the updater's write-preflight passes and the download attempt actually reaches
// HTTP request construction. doUpdateAgent shares the exact same serverURL
// wiring, so this proves the class.
//
// Wave-06 security remediation update: doUpdateWatchdog now routes downloads
// through the agent's shared outbound network policy (agent/internal/netpolicy),
// which rejects ANY loopback destination outright and unconditionally — the
// same protection that closes SSRF-AGENT-001 also means neither local httptest
// server below can ever actually be dialed. The download therefore always
// fails now, and this test can no longer prove routing by observing which
// server received a request. Instead it inspects the returned error: net/http
// wraps every transport/policy error in a *url.Error that names the exact
// request URL it attempted (this is netpolicy's own documented limitation —
// see its package doc — which is why production code must never log this raw
// error, only errors.As to *netpolicy.PolicyError and log .Reason; a TEST
// asserting on it is fine). Asserting on that URL proves doUpdateWatchdog
// targeted the live promoted backup, not the stale cfg.ServerURL snapshot of
// the dead primary — the same property #2478 fixed, just observed differently.
func TestDoUpdateWatchdogFollowsFailoverBaseURLPromotion(t *testing.T) {
	// deadPrimary stands in for the failed primary captured in cfg at startup.
	deadPrimary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "dead primary must not be contacted", http.StatusGone)
	}))
	defer deadPrimary.Close()

	// promotedBackup is what the FailoverClient was retargeted to.
	promotedBackup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer promotedBackup.Close()

	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	defer func() { _ = journal.Close() }()

	// cfg pins the dead primary — proving doUpdateWatchdog does not read
	// cfg.ServerURL for the download origin.
	cfg := &config.Config{AgentID: "agent-1", ServerURL: deadPrimary.URL}
	tokens := &tokenHolder{}
	tokens.Replace("tok")

	// The FailoverClient starts on the dead primary, then is promoted to the
	// backup — exactly what noteFailoverHeartbeatFailure -> SetBaseURL does.
	fc := watchdog.NewFailoverClient(deadPrimary.URL, "agent-1", "tok", nil)
	fc.SetBaseURL(promotedBackup.URL)

	updateErr := doUpdateWatchdog("2.1.0", fc.BaseURL, cfg, tokens, journal)
	if updateErr == nil {
		t.Fatal("expected doUpdateWatchdog to fail: both test servers are loopback, which the shared network policy always rejects regardless of which origin was targeted")
	}

	msg := updateErr.Error()
	if strings.Contains(msg, deadPrimary.URL) {
		t.Fatalf("doUpdateWatchdog targeted the dead primary (cfg.ServerURL) after failover promotion (#2478): %v", updateErr)
	}
	if !strings.Contains(msg, promotedBackup.URL) {
		t.Fatalf("doUpdateWatchdog did not target the promoted backup (fc.BaseURL): %v", updateErr)
	}
}
