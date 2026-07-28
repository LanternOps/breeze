package helper

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/updater"
)

// TestDefaultHelperDownloaderRejectsOffOriginRedirect (pre-wave-06 test,
// DELETED — see below) used to prove the production helper download path
// never follows an off-origin CDN redirect, by pointing a local httptest
// "control plane" at a local httptest "evil CDN" via a 302 and asserting the
// evil server was never hit. This is the core of the original HIGH-severity
// finding: the old downloadFile used http.DefaultClient (follows redirects)
// and ran the result as SYSTEM/root with no integrity check.
//
// It no longer holds as written: since the wave-06 network-policy hardening,
// EVERY loopback destination is rejected outright and unconditionally by
// agent/internal/netpolicy, so "control" (a local httptest server) is itself
// unreachable and the request now fails before it ever reaches control's
// redirect handler — evilHits becomes structurally unreachable, and the test
// would pass even if off-origin redirects were followed unconditionally
// (i.e. it regressed to vacuous, the same defect the review flagged in
// TestDownloadFromURL_IgnoresHostileProxyEnvironment).
//
// I deleted it rather than rebuild it here: defaultHelperDownloader has no
// seam to inject a netpolicy.Resolver (it constructs updater.New(cfg)
// entirely inside its own closure — see helperUpdaterConfig below), so a
// helper-package test cannot make the control-plane hop reachable without
// adding test-only surface to production code for a property this package
// does not itself implement. defaultHelperDownloader contributes no
// redirect-handling logic of its own; it only builds an *updater.Config
// (Component: "helper" plus the same ServerURL/BackupServerURL/AuthToken
// shape every other updater.New caller uses) and delegates to
// updater.Updater.DownloadBinary. The off-origin-redirect property is
// covered where it is actually enforced:
//   - agent/internal/netpolicy/http_test.go: TestRedirectToUnsafeTargetRejected,
//     TestRedirectToPrivateAddressRejected, TestRedirectCrossOriginStripsCredentials
//   - agent/internal/updater/updater_security_test.go:
//     TestClient_RedirectPolicy_RejectsHTTPSDowngrade,
//     TestClient_RedirectPolicy_StripsAuthorizationOnOriginChange,
//     TestClient_RedirectPolicy_EnforcesTenHopLimit,
//     TestClient_RedirectPolicy_RejectsHopToLoopback,
//     TestClient_RedirectPolicy_RejectsHopToMetadata (redirect-hop coverage,
//     not just an initial target)
//
// TestHelperUpdaterConfig_UsesHelperComponent confirms the verified downloader
// queries the agent-versions download endpoint with component=helper, so the
// signed release manifest's helper asset (breeze-helper-*) is the trust
// anchor — not the unauthenticated /download/helper/:os/:arch redirect route.
//
// This asserts the built *updater.Config directly (via helperUpdaterConfig)
// rather than observing an actual HTTP request: since the wave-06 network-
// policy hardening, no test in this package can complete a real request
// against a local httptest server at all (see the deleted-test comment
// above).
func TestHelperUpdaterConfig_UsesHelperComponent(t *testing.T) {
	cfg := helperUpdaterConfig(func() string { return "https://control.example" }, nil, secmem.NewSecureString("tok"), "9.9.9", nil)
	if cfg.Component != "helper" {
		t.Fatalf("helper updater config Component = %q, want %q", cfg.Component, "helper")
	}
}

// TestHelperUpdaterConfig_ThreadsBackupServerURL proves backupServerURL
// reaches updater.Config.BackupServerURL — the field netpolicy uses to admit
// the configured backup control plane into ControlPlaneOrigins. A Manager
// construction site that forgot to pass helper.WithBackupServerURL would
// silently produce a Config with an empty BackupServerURL here.
func TestHelperUpdaterConfig_ThreadsBackupServerURL(t *testing.T) {
	cfg := helperUpdaterConfig(
		func() string { return "https://primary.example" },
		func() string { return "https://backup.example" },
		secmem.NewSecureString("tok"), "9.9.9", nil,
	)
	if cfg.BackupServerURL != "https://backup.example" {
		t.Fatalf("BackupServerURL = %q, want %q", cfg.BackupServerURL, "https://backup.example")
	}
}

// TestHelperUpdaterConfig_NilBackupServerURLIsNoOp proves a nil
// backupServerURL provider (no WithBackupServerURL option set, or an agent
// build predating failover awareness) produces an empty BackupServerURL
// rather than panicking.
func TestHelperUpdaterConfig_NilBackupServerURLIsNoOp(t *testing.T) {
	cfg := helperUpdaterConfig(func() string { return "https://primary.example" }, nil, secmem.NewSecureString("tok"), "9.9.9", nil)
	if cfg.BackupServerURL != "" {
		t.Fatalf("BackupServerURL = %q, want empty for a nil provider", cfg.BackupServerURL)
	}
}

// TestDefaultHelperDownloaderResolvesServerURLAtCallTime is the #2478
// regression guard: the downloader must read the serverURL provider on every
// call, so a backup-server-URL promotion (#2323) that happens AFTER the
// manager is constructed is honored. Before the #2478 fix the URL was a plain
// string baked into the closure at construction, so the helper kept fetching
// from the dead primary for the rest of the process lifetime after a
// failover.
//
// Wave-06 update: both test servers are loopback, which the shared network
// policy now rejects outright regardless of which one is targeted, so this
// can no longer prove routing by observing which server received a request
// (see the deleted TestDefaultHelperDownloaderRejectsOffOriginRedirect's
// comment above for the general pattern this hits).
// net/http wraps the rejection in a *url.Error that names the exact request
// URL attempted; asserting on that (test-only — production code must never
// log this raw error, only the bounded netpolicy.PolicyError.Reason) proves
// the live promoted URL was used, not the stale captured-at-construction one.
func TestDefaultHelperDownloaderResolvesServerURLAtCallTime(t *testing.T) {
	deadPrimary := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "dead primary must not be contacted", http.StatusGone)
	}))
	defer deadPrimary.Close()

	promotedBackup := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer promotedBackup.Close()

	// The provider starts on the dead primary, then is promoted to the backup
	// AFTER the downloader closure is built — exactly the failover ordering.
	current := deadPrimary.URL
	dl := defaultHelperDownloader(func() string { return current }, nil, secmem.NewSecureString("tok"), "1.2.3", nil)
	current = promotedBackup.URL

	_, err := dl("1.2.3")
	if err == nil {
		t.Fatal("expected the download to fail: both test servers are loopback, which the shared network policy always rejects")
	}
	msg := err.Error()
	if strings.Contains(msg, deadPrimary.URL) {
		t.Fatalf("helper downloader targeted the dead primary after promotion — URL was captured at construction (#2478): %v", err)
	}
	if !strings.Contains(msg, promotedBackup.URL) {
		t.Fatalf("helper downloader did not target the promoted backup URL: %v", err)
	}
}

// Compile-time guard: the default helper downloader signature must stay
// compatible with updater.Updater.DownloadBinary so the production shim is a
// one-liner and the seam stays honest.
var _ func(string) (string, error) = (&updater.Updater{}).DownloadBinary
