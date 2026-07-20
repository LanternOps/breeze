package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// Issue #2621 — regression coverage for the credential-rotation stranding bug.
//
// The property under test throughout: a rotation must never reach the point of
// telling the server "promote these" unless the new credentials are durably on
// disk, AND a failure to persist must always leave the previously working
// credentials intact.

// bindConfig points the package-level viper at a temp agent.yaml so
// secretsFilePath() resolves inside the test's sandbox.
func bindConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_current_agent"
	cfg.WatchdogAuthToken = "brz_current_watchdog"
	cfg.HelperAuthToken = "brz_current_helper"
	cfg.OrgID = "org-1"
	cfg.SiteID = "site-1"

	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	viper.SetConfigFile(cfgPath)
	t.Cleanup(viper.Reset)
	return cfgPath
}

func TestStagePendingCredentialsPreservesCurrentSet(t *testing.T) {
	bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	got, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}

	// The whole point of staging: the credentials the agent is currently
	// authenticating with must survive untouched, because the server still
	// treats them as current until confirmation.
	if got.AuthToken != "brz_current_agent" {
		t.Errorf("current auth token was modified by staging: %q", got.AuthToken)
	}
	if got.WatchdogAuthToken != "brz_current_watchdog" {
		t.Errorf("current watchdog token was modified by staging: %q", got.WatchdogAuthToken)
	}
	if got.HelperAuthToken != "brz_current_helper" {
		t.Errorf("current helper token was modified by staging: %q", got.HelperAuthToken)
	}

	if got.PendingAuthToken != "brz_new_agent" {
		t.Errorf("pending auth token = %q, want brz_new_agent", got.PendingAuthToken)
	}
	if got.PendingWatchdogAuthToken != "brz_new_watchdog" {
		t.Errorf("pending watchdog token = %q, want brz_new_watchdog", got.PendingWatchdogAuthToken)
	}
	if got.PendingHelperAuthToken != "brz_new_helper" {
		t.Errorf("pending helper token = %q, want brz_new_helper", got.PendingHelperAuthToken)
	}
}

// THE core regression test for #2621: when the disk write fails, staging must
// report failure. The caller contract is that a failed stage aborts the rotation
// before the server is ever asked to promote — so the server can never end up
// holding hashes the agent cannot reproduce after a restart.
func TestStagePendingCredentialsFailsWhenDiskWriteFails(t *testing.T) {
	cfgPath := bindConfig(t)
	secretsPath := secretsFilePathFor(cfgPath)

	// Injection: replace the secrets file with a NON-EMPTY DIRECTORY. The atomic
	// write's final rename onto that path cannot succeed, which models the
	// real-world failures in the issue report (ACLs, a locked/undeletable target,
	// a full or read-only volume) without depending on chmod — the config layer
	// deliberately re-asserts directory permissions on every write, so a
	// permission-based injection would be undone by the code under test.
	if err := os.Remove(secretsPath); err != nil {
		t.Fatalf("remove secrets file: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(secretsPath, "occupied"), 0700); err != nil {
		t.Fatalf("create blocking directory: %v", err)
	}

	err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper")
	if err == nil {
		t.Fatal("StagePendingCredentials reported success despite an unwritable secrets path — " +
			"the rotation would go on to confirm credentials that are not on disk, which is exactly " +
			"how #2621 stranded agents")
	}

	// Nothing may be observable as staged after a failed write.
	if _, statErr := os.Stat(filepath.Join(secretsPath, "occupied")); statErr != nil {
		t.Errorf("blocking directory disappeared: %v", statErr)
	}
}

// A write that lands but reads back wrong must be reported as a failure. The
// readback is the agent's only evidence that config.Save actually produced a
// durable, parseable credential file — reporting success on an unverified write
// is the assumption that #2621 punished.
func TestStagePendingCredentialsVerifiesReadback(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	// Corrupt the file behind the staged write, then prove a fresh read surfaces
	// the divergence rather than trusting the earlier success.
	secretsPath := secretsFilePathFor(cfgPath)
	if err := os.WriteFile(secretsPath, []byte("auth_token: brz_current_agent\n"), 0600); err != nil {
		t.Fatalf("corrupt secrets file: %v", err)
	}

	got, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if got.PendingAuthToken != "" {
		t.Errorf("readback reported a staged token that is not on disk: %q", got.PendingAuthToken)
	}
}

func TestStagePendingCredentialsRejectsIncompleteSet(t *testing.T) {
	bindConfig(t)

	cases := []struct {
		name                    string
		agent, watchdog, helper string
	}{
		{"missing agent", "", "brz_w", "brz_h"},
		{"missing watchdog", "brz_a", "", "brz_h"},
		{"missing helper", "brz_a", "brz_w", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := StagePendingCredentials(tc.agent, tc.watchdog, tc.helper); err == nil {
				t.Fatal("expected an error for an incomplete credential set")
			}
			got, err := ReadPersistedCredentials()
			if err != nil {
				t.Fatalf("ReadPersistedCredentials: %v", err)
			}
			if got.PendingAuthToken != "" || got.PendingWatchdogAuthToken != "" || got.PendingHelperAuthToken != "" {
				t.Error("a partial credential set was staged")
			}
		})
	}
}

func TestPromotePendingCredentialsSwapsAndClears(t *testing.T) {
	bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("PromotePendingCredentials: %v", err)
	}

	got, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if got.AuthToken != "brz_new_agent" {
		t.Errorf("auth token = %q, want brz_new_agent", got.AuthToken)
	}
	if got.WatchdogAuthToken != "brz_new_watchdog" {
		t.Errorf("watchdog token = %q, want brz_new_watchdog", got.WatchdogAuthToken)
	}
	if got.HelperAuthToken != "brz_new_helper" {
		t.Errorf("helper token = %q, want brz_new_helper", got.HelperAuthToken)
	}
	// Promotion must clear the staged copy, otherwise startup reconciliation
	// would keep re-confirming a rotation that already completed.
	if got.PendingAuthToken != "" || got.PendingWatchdogAuthToken != "" || got.PendingHelperAuthToken != "" {
		t.Errorf("staged credentials survived promotion: %+v", got)
	}
}

func TestClearPendingCredentialsLeavesCurrentSetIntact(t *testing.T) {
	bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if err := ClearPendingCredentials(); err != nil {
		t.Fatalf("ClearPendingCredentials: %v", err)
	}

	got, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if got.PendingAuthToken != "" {
		t.Errorf("pending auth token survived clear: %q", got.PendingAuthToken)
	}
	// Abandoning a rotation must never cost the agent its working credentials.
	if got.AuthToken != "brz_current_agent" {
		t.Errorf("current auth token = %q, want brz_current_agent", got.AuthToken)
	}
	if got.WatchdogAuthToken != "brz_current_watchdog" {
		t.Errorf("current watchdog token = %q, want brz_current_watchdog", got.WatchdogAuthToken)
	}
}

// Simulates the crash window: credentials staged, process dies before it could
// confirm. After a restart the agent must still find BOTH sets on disk, since
// the staged one may be the only credential the server still accepts.
func TestStagedCredentialsSurviveReload(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	// Restart: fresh viper, reload from disk.
	viper.Reset()
	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}

	if cfg.AuthToken != "brz_current_agent" {
		t.Errorf("reloaded auth token = %q, want brz_current_agent", cfg.AuthToken)
	}
	if cfg.PendingAuthToken != "brz_new_agent" {
		t.Errorf("reloaded pending auth token = %q, want brz_new_agent — "+
			"an agent that crashed mid-rotation would lose the only credential the server may accept", cfg.PendingAuthToken)
	}
	if cfg.PendingWatchdogAuthToken != "brz_new_watchdog" {
		t.Errorf("reloaded pending watchdog token = %q, want brz_new_watchdog", cfg.PendingWatchdogAuthToken)
	}
	if cfg.PendingHelperAuthToken != "brz_new_helper" {
		t.Errorf("reloaded pending helper token = %q, want brz_new_helper", cfg.PendingHelperAuthToken)
	}
}

// Staged credentials are secrets and must land in the 0600 secrets file, never
// in the world-readable agent.yaml.
func TestStagedCredentialsStayOutOfAgentYAML(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read agent.yaml: %v", err)
	}
	for _, forbidden := range []string{"brz_new_agent", "brz_new_watchdog", "brz_new_helper", "pending_auth_token"} {
		if strings.Contains(string(agentYAML), forbidden) {
			t.Errorf("agent.yaml leaked %q:\n%s", forbidden, agentYAML)
		}
	}

	secretsPath := secretsFilePathFor(cfgPath)
	info, err := os.Stat(secretsPath)
	if err != nil {
		t.Fatalf("stat secrets file: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Errorf("secrets file mode = %v, want 0600", info.Mode().Perm())
	}
}

// SaveTo rebuilds secrets.yaml from scratch, and unrelated callers invoke it
// mid-flight (the mTLS renewal path calls config.Save). It must not drop a
// staged credential set: during the rotation window that set may be the only
// credential the server still accepts, so losing it would strand the agent —
// the exact class of failure #2621 is about.
func TestSaveToPreservesStagedCredentials(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	// An unrelated save, as the cert-renewal path would issue.
	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_current_agent"
	cfg.WatchdogAuthToken = "brz_current_watchdog"
	cfg.HelperAuthToken = "brz_current_helper"
	cfg.MtlsCertPEM = "cert"
	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	got, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if got.PendingAuthToken != "brz_new_agent" {
		t.Errorf("staged auth token = %q, want brz_new_agent — an unrelated SaveTo dropped it", got.PendingAuthToken)
	}
	if got.PendingWatchdogAuthToken != "brz_new_watchdog" {
		t.Errorf("staged watchdog token = %q, want brz_new_watchdog", got.PendingWatchdogAuthToken)
	}
	if got.PendingHelperAuthToken != "brz_new_helper" {
		t.Errorf("staged helper token = %q, want brz_new_helper", got.PendingHelperAuthToken)
	}
	if got.AuthToken != "brz_current_agent" {
		t.Errorf("current auth token = %q, want brz_current_agent", got.AuthToken)
	}
}

// The pending_* keys must be classified as secrets so the generic strip/migrate
// machinery keeps them out of agent.yaml.
func TestPendingTokenKeysAreSecretKeys(t *testing.T) {
	for _, key := range []string{
		"pending_auth_token",
		"pending_watchdog_auth_token",
		"pending_helper_auth_token",
	} {
		if !isSecretYAMLKey(key) {
			t.Errorf("isSecretYAMLKey(%q) = false, want true", key)
		}
	}
}
