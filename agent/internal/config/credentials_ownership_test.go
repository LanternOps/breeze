package config

import (
	"os"
	"testing"
)

// Issue #2773 — SaveTo must not be a second writer of credential state.
//
// secrets.yaml's credential keys are owned by StagePendingCredentials,
// PromotePendingCredentials and ClearPendingCredentials, which update the file
// directly under persistMu and never touch the caller's *Config. SaveTo is a
// whole-file rewrite driven by a *Config snapshot that can be arbitrarily stale
// relative to those writers: Load copies pending_* into the struct at startup
// and nothing ever refreshes them, and the mTLS paths capture the bearer token
// BEFORE taking any lock. Letting that snapshot win put a credential on disk
// that the server no longer accepts — or took away the one it does.

// saveUnrelated models the real callers (the mTLS renewal paths): an
// in-memory config that is only trying to persist certificate material.
func saveUnrelated(t *testing.T, cfgPath string, mutate func(*Config)) {
	t.Helper()
	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.MtlsCertPEM = "renewed-cert"
	mutate(cfg)
	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
}

func mustRead(t *testing.T) *PersistedCredentials {
	t.Helper()
	got, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	return got
}

// The in-memory Pending* fields are a startup snapshot. After the staged set
// they describe was cleared from disk, an unrelated SaveTo must not resurrect it.
func TestSaveToDoesNotResurrectClearedStagedSetFromStaleConfig(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := ClearPendingCredentials(); err != nil {
		t.Fatalf("ClearPendingCredentials: %v", err)
	}
	saveUnrelated(t, cfgPath, func(c *Config) {
		c.PendingAuthToken = "brz_stale_startup_agent"
		c.PendingWatchdogAuthToken = "brz_stale_startup_watchdog"
		c.PendingHelperAuthToken = "brz_stale_startup_helper"
	})

	got := mustRead(t)
	if got.PendingAuthToken != "" || got.PendingWatchdogAuthToken != "" || got.PendingHelperAuthToken != "" {
		t.Errorf("SaveTo resurrected a staged set from a stale in-memory snapshot: %+v", got)
	}
}

// The strand: the server has PROMOTED the staged set on disk, but the local
// promote has not happened yet (confirm response lost, or the promote write
// failed). The staged copy on disk is then the agent's only copy of the
// server's current credential. A stale in-memory Pending* must not replace it.
func TestSaveToDoesNotOverwriteLiveStagedSetWithStaleConfig(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := StagePendingCredentials("brz_live_agent", "brz_live_watchdog", "brz_live_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	saveUnrelated(t, cfgPath, func(c *Config) {
		c.PendingAuthToken = "brz_stale_startup_agent"
		c.PendingWatchdogAuthToken = "brz_stale_startup_watchdog"
		c.PendingHelperAuthToken = "brz_stale_startup_helper"
	})

	got := mustRead(t)
	if got.PendingAuthToken != "brz_live_agent" ||
		got.PendingWatchdogAuthToken != "brz_live_watchdog" ||
		got.PendingHelperAuthToken != "brz_live_helper" {
		t.Errorf("SaveTo replaced the live staged set with a stale snapshot: %+v", got)
	}
}

// The mTLS paths read the bearer token, THEN take the lock and SaveTo. A
// rotation that promotes in between leaves them holding the superseded token,
// which the old "in-memory wins" rule wrote back over the promoted one: memory
// runs on the new token, disk holds the old one, and the first restart after
// the 5-minute previous-token grace is a permanent 401.
func TestSaveToDoesNotRevertPromotedCredentialsWithStaleToken(t *testing.T) {
	cfgPath := bindConfig(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("PromotePendingCredentials: %v", err)
	}
	saveUnrelated(t, cfgPath, func(c *Config) {
		c.AuthToken = "brz_current_agent" // captured before the promotion
		c.WatchdogAuthToken = "brz_current_watchdog"
		c.HelperAuthToken = "brz_current_helper"
	})

	got := mustRead(t)
	if got.AuthToken != "brz_new_agent" {
		t.Errorf("auth token = %q, want brz_new_agent — SaveTo reverted a promoted credential", got.AuthToken)
	}
	if got.WatchdogAuthToken != "brz_new_watchdog" {
		t.Errorf("watchdog token = %q, want brz_new_watchdog", got.WatchdogAuthToken)
	}
	if got.HelperAuthToken != "brz_new_helper" {
		t.Errorf("helper token = %q, want brz_new_helper", got.HelperAuthToken)
	}

	// The mTLS material the caller was actually saving must still land.
	reloaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if reloaded.MtlsCertPEM != "renewed-cert" {
		t.Errorf("mtls cert = %q, want renewed-cert", reloaded.MtlsCertPEM)
	}
}

// A secrets file that exists but cannot be parsed used to be logged and then
// OVERWRITTEN from the in-memory snapshot — dropping every credential the
// snapshot lacked, including a staged set the server may already have
// promoted. It must fail closed and leave the file for the next attempt.
func TestSaveToFailsClosedWhenExistingSecretsUnreadable(t *testing.T) {
	cfgPath := bindConfig(t)
	secrets := secretsFilePathFor(cfgPath)
	corrupt := []byte("auth_token: [unterminated\n")
	if err := os.WriteFile(secrets, corrupt, 0600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.MtlsCertPEM = "renewed-cert"
	if err := SaveTo(cfg, cfgPath); err == nil {
		t.Fatal("SaveTo succeeded over an unreadable secrets file; it must fail closed")
	}
	after, err := os.ReadFile(secrets)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(after) != string(corrupt) {
		t.Errorf("secrets file was rewritten despite the failed read: %q", after)
	}
}

// Enrollment is the one caller whose in-memory credentials ARE authoritative:
// it just received a fresh identity. It must replace whatever is on disk and
// drop any staged set belonging to the previous identity.
func TestSaveEnrollmentReplacesCredentialsAndDropsStagedSet(t *testing.T) {
	cfgPath := bindConfig(t)
	if err := StagePendingCredentials("brz_old_staged_agent", "brz_old_staged_watchdog", "brz_old_staged_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_enrolled_agent"
	cfg.WatchdogAuthToken = "brz_enrolled_watchdog"
	cfg.HelperAuthToken = "brz_enrolled_helper"
	// A config loaded before re-enrolling still carries the old staged set.
	cfg.PendingAuthToken = "brz_old_staged_agent"
	cfg.PendingWatchdogAuthToken = "brz_old_staged_watchdog"
	cfg.PendingHelperAuthToken = "brz_old_staged_helper"
	if err := SaveEnrollment(cfg, cfgPath); err != nil {
		t.Fatalf("SaveEnrollment: %v", err)
	}

	got := mustRead(t)
	if got.AuthToken != "brz_enrolled_agent" || got.WatchdogAuthToken != "brz_enrolled_watchdog" || got.HelperAuthToken != "brz_enrolled_helper" {
		t.Errorf("enrollment did not replace the credential set: %+v", got)
	}
	if got.PendingAuthToken != "" || got.PendingWatchdogAuthToken != "" || got.PendingHelperAuthToken != "" {
		t.Errorf("enrollment kept a staged set from the previous identity: %+v", got)
	}
}
