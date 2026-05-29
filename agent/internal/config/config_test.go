package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/spf13/viper"
)

func TestIsEnrolled(t *testing.T) {
	tests := []struct {
		name string
		cfg  *Config
		want bool
	}{
		{"nil config", nil, false},
		{"empty config", &Config{}, false},
		{"agent id only (torn write)", &Config{AgentID: "abc"}, false},
		{"auth token only (torn write)", &Config{AuthToken: "tok"}, false},
		{"both present", &Config{AgentID: "abc", AuthToken: "tok"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsEnrolled(tt.cfg); got != tt.want {
				t.Errorf("IsEnrolled(%+v) = %v, want %v", tt.cfg, got, tt.want)
			}
		})
	}
}

func TestSaveToKeepsFullAgentTokensOutOfAgentYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent"
	cfg.WatchdogAuthToken = "brz_watchdog"
	cfg.HelperAuthToken = "brz_helper"
	cfg.OrgID = "org-1"
	cfg.SiteID = "site-1"

	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read agent.yaml: %v", err)
	}
	text := string(agentYAML)
	for _, forbidden := range []string{"\nauth_token:", "\nwatchdog_auth_token:", "brz_agent", "brz_watchdog"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("agent.yaml contains %q:\n%s", forbidden, text)
		}
	}
	if strings.HasPrefix(text, "auth_token:") || strings.HasPrefix(text, "watchdog_auth_token:") {
		t.Fatalf("agent.yaml contains full-token key:\n%s", text)
	}
	if !strings.Contains(text, "helper_auth_token: brz_helper") {
		t.Fatalf("agent.yaml missing helper-scoped token:\n%s", text)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if loaded.AuthToken != "brz_agent" {
		t.Fatalf("AuthToken = %q, want brz_agent", loaded.AuthToken)
	}
	if loaded.WatchdogAuthToken != "brz_watchdog" {
		t.Fatalf("WatchdogAuthToken = %q, want brz_watchdog", loaded.WatchdogAuthToken)
	}
	if loaded.HelperAuthToken != "brz_helper" {
		t.Fatalf("HelperAuthToken = %q, want brz_helper", loaded.HelperAuthToken)
	}
}

func TestMigrateInlineSecretsToSecretFileScrubsAgentYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(`
agent_id: agent-1
server_url: https://api.example.test
auth_token: brz_agent_inline
watchdog_auth_token: brz_watchdog_inline
helper_auth_token: brz_helper
`), 0o640); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	if err := migrateInlineSecretsToSecretFile(cfgPath); err != nil {
		t.Fatalf("migrateInlineSecretsToSecretFile returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read scrubbed agent.yaml: %v", err)
	}
	text := string(agentYAML)
	for _, forbidden := range []string{"brz_agent_inline", "brz_watchdog_inline", "\nauth_token:", "\nwatchdog_auth_token:"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("scrubbed agent.yaml contains %q:\n%s", forbidden, text)
		}
	}
	if !strings.Contains(text, "helper_auth_token: brz_helper") {
		t.Fatalf("scrubbed agent.yaml lost helper token:\n%s", text)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load after migration returned error: %v", err)
	}
	if loaded.AuthToken != "brz_agent_inline" {
		t.Fatalf("AuthToken = %q, want migrated token", loaded.AuthToken)
	}
	if loaded.WatchdogAuthToken != "brz_watchdog_inline" {
		t.Fatalf("WatchdogAuthToken = %q, want migrated token", loaded.WatchdogAuthToken)
	}
}

func TestSetAndPersistScrubsLegacyInlineSecrets(t *testing.T) {
	defer viper.Reset()

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(`
agent_id: agent-1
server_url: https://api.example.test
auth_token: brz_agent_inline
watchdog_auth_token: brz_watchdog_inline
helper_auth_token: brz_helper
log_level: info
`), 0o640); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if err := SetAndPersist("log_level", "debug"); err != nil {
		t.Fatalf("SetAndPersist returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read scrubbed agent.yaml: %v", err)
	}
	text := string(agentYAML)
	for _, forbidden := range []string{"brz_agent_inline", "brz_watchdog_inline", "\nauth_token:", "\nwatchdog_auth_token:"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("agent.yaml contains %q after SetAndPersist:\n%s", forbidden, text)
		}
	}
	if !strings.Contains(text, "log_level: debug") {
		t.Fatalf("agent.yaml missing persisted non-secret update:\n%s", text)
	}

	secretsYAML, err := os.ReadFile(filepath.Join(dir, "secrets.yaml"))
	if err != nil {
		t.Fatalf("read secrets.yaml: %v", err)
	}
	secretsText := string(secretsYAML)
	for _, required := range []string{"auth_token: brz_agent_inline", "watchdog_auth_token: brz_watchdog_inline"} {
		if !strings.Contains(secretsText, required) {
			t.Fatalf("secrets.yaml missing %q:\n%s", required, secretsText)
		}
	}
}

// TestSaveToWritesAtomicallyWithoutLeftoverTempFiles guards #642: SaveTo must
// not leave .partial scratch files behind on success, and the on-disk files
// must contain the full serialized config (not zero-length or truncated).
func TestSaveToWritesAtomicallyWithoutLeftoverTempFiles(t *testing.T) {
	defer viper.Reset()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	const agentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg := Default()
	cfg.AgentID = agentID
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent_atomic"
	cfg.WatchdogAuthToken = "brz_watchdog_atomic"

	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".partial") || strings.Contains(e.Name(), ".tmp") {
			t.Fatalf("SaveTo left scratch file %q behind", e.Name())
		}
	}

	agentInfo, err := os.Stat(cfgPath)
	if err != nil {
		t.Fatalf("stat agent.yaml: %v", err)
	}
	if agentInfo.Size() == 0 {
		t.Fatalf("agent.yaml is zero-length after SaveTo")
	}
	secretsInfo, err := os.Stat(filepath.Join(dir, "secrets.yaml"))
	if err != nil {
		t.Fatalf("stat secrets.yaml: %v", err)
	}
	if secretsInfo.Size() == 0 {
		t.Fatalf("secrets.yaml is zero-length after SaveTo")
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.AgentID != agentID || loaded.AuthToken != "brz_agent_atomic" || loaded.WatchdogAuthToken != "brz_watchdog_atomic" {
		t.Fatalf("Load returned incomplete config: %+v", loaded)
	}

	// On POSIX, agent.yaml must be world-readable (0644) so the Breeze Helper
	// ("Breeze Assist"), which runs as the logged-in user and is neither the
	// owner (root) nor in the owning group (wheel), can read it. secrets.yaml
	// holds the full agent/watchdog tokens and mTLS keys and stays root-only
	// (0600). Skip on Windows where POSIX mode bits don't map directly.
	if runtime.GOOS != "windows" {
		if mode := agentInfo.Mode().Perm(); mode != 0o644 {
			t.Errorf("agent.yaml mode = %o, want 0644 (Helper runs as logged-in user)", mode)
		}
		if mode := secretsInfo.Mode().Perm(); mode != 0o600 {
			t.Errorf("secrets.yaml mode = %o, want 0600", mode)
		}
	}
}

// TestEnforceConfigPermissionsAreHelperReadable guards the bug where the
// SR-001..SR-024 hardening (#568) tightened agent.yaml to 0640 in a 0750 dir,
// which the Breeze Helper (running as the logged-in user, not root/wheel) could
// not read — surfacing as "Breeze Assist requires the Breeze agent...". The
// config dir must be traversable and agent.yaml world-readable, while
// secrets.yaml stays owner-only.
func TestEnforceConfigPermissionsAreHelperReadable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX mode bits don't apply on Windows; DACLs covered separately")
	}
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	secretsPath := filepath.Join(dir, "secrets.yaml")

	// Start from deliberately over-tight perms to prove the enforce funcs loosen
	// the config (and keep the secret locked).
	if err := os.WriteFile(cfgPath, []byte("server_url: x\n"), 0o600); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	if err := os.WriteFile(secretsPath, []byte("auth_token: x\n"), 0o644); err != nil {
		t.Fatalf("write secrets.yaml: %v", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatalf("chmod dir: %v", err)
	}

	if err := enforceConfigDirPermissions(dir); err != nil {
		t.Fatalf("enforceConfigDirPermissions: %v", err)
	}
	if err := enforceConfigFilePermissions(cfgPath); err != nil {
		t.Fatalf("enforceConfigFilePermissions: %v", err)
	}
	if err := enforceSecretFilePermissions(secretsPath); err != nil {
		t.Fatalf("enforceSecretFilePermissions: %v", err)
	}

	dirMode := statPerm(t, dir)
	if dirMode != 0o755 {
		t.Errorf("config dir mode = %o, want 0755 (others must traverse to reach agent.yaml)", dirMode)
	}
	cfgMode := statPerm(t, cfgPath)
	if cfgMode != 0o644 {
		t.Errorf("agent.yaml mode = %o, want 0644 (Helper must read it as the logged-in user)", cfgMode)
	}
	if cfgMode&0o004 == 0 {
		t.Errorf("agent.yaml mode = %o is not other-readable; Helper cannot read it", cfgMode)
	}
	secretsMode := statPerm(t, secretsPath)
	if secretsMode != 0o600 {
		t.Errorf("secrets.yaml mode = %o, want 0600 (full tokens/keys must stay owner-only)", secretsMode)
	}
	if secretsMode&0o077 != 0 {
		t.Errorf("secrets.yaml mode = %o leaks group/other access to real secrets", secretsMode)
	}
}

func statPerm(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Mode().Perm()
}

// TestAtomicWriteFileOverwritesExistingFile verifies the helper correctly
// replaces an existing file (the common case — every SaveTo after enrollment).
func TestAtomicWriteFileOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(path, []byte("old: value\n"), 0o600); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := atomicWriteFile(path, []byte("new: value\n"), 0o640); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "new: value\n" {
		t.Fatalf("content = %q, want %q", got, "new: value\n")
	}
	// No .partial leftover.
	if _, err := os.Stat(path + ".partial"); !os.IsNotExist(err) {
		t.Fatalf("expected .partial removed, got err=%v", err)
	}
}

// TestAtomicWriteFileRecoversFromStaleTemp guards the case where a previous
// crash left a .partial behind. The next write must succeed, not fail with
// O_EXCL EEXIST. Asserts both the new file is correct and the stale .partial
// was cleaned up — together these pin the pre-Remove + O_EXCL contract.
func TestAtomicWriteFileRecoversFromStaleTemp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "agent.yaml")
	stalePartial := path + ".partial"
	if err := os.WriteFile(stalePartial, []byte("stale-contents-from-prior-crash"), 0o600); err != nil {
		t.Fatalf("seed stale: %v", err)
	}
	if err := atomicWriteFile(path, []byte("fresh\n"), 0o640); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "fresh\n" {
		t.Fatalf("content = %q, want fresh", got)
	}
	// The stale .partial must be gone (consumed by the rename), not just
	// overwritten with the fresh content — otherwise we'd be silently
	// leaking scratch files on every crash recovery.
	if _, err := os.Stat(stalePartial); !os.IsNotExist(err) {
		t.Fatalf("stale .partial still present after recovery, stat err=%v", err)
	}
}

// TestAtomicWriteFileCleansUpOnOpenFailure verifies that when the initial
// OpenFile fails (here: parent dir does not exist), no .partial is left
// behind. Pins the no-leftover invariant against future refactors that
// might drop the os.Remove calls in the error paths.
func TestAtomicWriteFileCleansUpOnOpenFailure(t *testing.T) {
	dir := t.TempDir()
	// path under a non-existent subdir → OpenFile fails with ENOENT.
	path := filepath.Join(dir, "does-not-exist", "agent.yaml")
	err := atomicWriteFile(path, []byte("data"), 0o640)
	if err == nil {
		t.Fatalf("expected error from atomicWriteFile, got nil")
	}
	if _, statErr := os.Stat(path + ".partial"); !os.IsNotExist(statErr) {
		t.Fatalf(".partial should not exist after failed open, stat err=%v", statErr)
	}
}

func TestMaxHeartbeatStalenessSecAlias(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	yaml := `
agent_id: 00000000-0000-0000-0000-000000000001
server_url: https://example.com
watchdog:
  max_heartbeat_staleness_sec: 240
`
	if err := os.WriteFile(cfgPath, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	// Reset viper between tests because it's a global singleton. Use defer
	// so a t.Fatal in Load can't leak singleton state to the next test
	// (consistent with the rest of this file).
	viper.Reset()
	defer viper.Reset()

	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	want := 240 * time.Second
	if cfg.Watchdog.HeartbeatStaleThreshold != want {
		t.Fatalf("HeartbeatStaleThreshold: want %v, got %v", want, cfg.Watchdog.HeartbeatStaleThreshold)
	}
}

func TestWatchdogDefaults(t *testing.T) {
	cfg := Default()
	if cfg.Watchdog.RestartVerificationGrace != 30*time.Second {
		t.Errorf("RestartVerificationGrace default: want 30s, got %v", cfg.Watchdog.RestartVerificationGrace)
	}
	if cfg.Watchdog.RestartVerificationTimeout != 120*time.Second {
		t.Errorf("RestartVerificationTimeout default: want 120s, got %v", cfg.Watchdog.RestartVerificationTimeout)
	}
	if cfg.Watchdog.MaxRestartsPer24h != 5 {
		t.Errorf("MaxRestartsPer24h default: want 5, got %d", cfg.Watchdog.MaxRestartsPer24h)
	}
}

// TestIsSecretYAMLKey verifies the drift-proof predicate that decides which
// config keys belong in secrets.yaml vs agent.yaml. Finding #6.
func TestIsSecretYAMLKey(t *testing.T) {
	cases := map[string]bool{
		// Explicit secret keys (named in the switch).
		"auth_token":         true,
		"watchdog_auth_token": true,
		"mtls_cert_pem":      true,
		"mtls_key_pem":       true,
		"mtls_cert_expires":  true,
		// Caught by suffix rules (_access_key, _secret_key).
		"backup_s3_access_key": true,
		"backup_s3_secret_key": true,
		// Caught by suffix rules (_password, _secret, _token).
		"smtp_password": true,
		"some_token":    true,
		// Explicitly exempted: helper token MUST stay in agent.yaml for Helper.
		"helper_auth_token": false,
		// Non-secret keys that happen to contain "key" or "token" substrings
		// but don't match any suffix rule.
		"server_url":        false,
		"agent_id":          false,
		"backup_s3_bucket":  false,
		"backup_s3_region":  false,
	}
	for key, want := range cases {
		if got := isSecretYAMLKey(key); got != want {
			t.Errorf("isSecretYAMLKey(%q) = %v, want %v", key, got, want)
		}
	}
}

// TestSaveToStripsBackupS3SecretsFromAgentYAML is the regression test for
// Finding #6: backup_s3_access_key and backup_s3_secret_key must not appear in
// agent.yaml (world-readable) after migration. This mirrors
// TestMigrateInlineSecretsToSecretFileScrubsAgentYAML but exercises the
// backup_s3_* keys that were absent from the original 5-key allowlist.
// helper_auth_token must still be present in agent.yaml.
func TestSaveToStripsBackupS3SecretsFromAgentYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	// Write agent.yaml with inline backup_s3 secrets (old/misconfigured format).
	if err := os.WriteFile(cfgPath, []byte(`
agent_id: agent-backup-1
server_url: https://api.example.test
helper_auth_token: brz_helper
backup_s3_bucket: my-bucket
backup_s3_region: us-east-1
backup_s3_access_key: AKIAIOSFODNN7EXAMPLE
backup_s3_secret_key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
`), 0o640); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	if err := migrateInlineSecretsToSecretFile(cfgPath); err != nil {
		t.Fatalf("migrateInlineSecretsToSecretFile returned error: %v", err)
	}

	agentYAML, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatalf("read scrubbed agent.yaml: %v", err)
	}
	text := string(agentYAML)

	// backup_s3_access_key and backup_s3_secret_key must NOT appear in agent.yaml.
	for _, forbidden := range []string{
		"backup_s3_access_key",
		"backup_s3_secret_key",
		"AKIAIOSFODNN7EXAMPLE",
		"wJalrXUtnFEMI",
	} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("scrubbed agent.yaml contains forbidden secret %q:\n%s", forbidden, text)
		}
	}

	// Non-secret backup fields must remain in agent.yaml.
	for _, required := range []string{"backup_s3_bucket: my-bucket", "backup_s3_region: us-east-1"} {
		if !strings.Contains(text, required) {
			t.Fatalf("scrubbed agent.yaml missing non-secret key %q:\n%s", required, text)
		}
	}

	// helper_auth_token must remain in agent.yaml (Helper reads it).
	if !strings.Contains(text, "helper_auth_token: brz_helper") {
		t.Fatalf("scrubbed agent.yaml lost helper token:\n%s", text)
	}

	// secrets.yaml must contain the S3 credentials.
	secretsYAML, err := os.ReadFile(filepath.Join(dir, "secrets.yaml"))
	if err != nil {
		t.Fatalf("read secrets.yaml: %v", err)
	}
	secretsText := string(secretsYAML)
	for _, required := range []string{
		"backup_s3_access_key: AKIAIOSFODNN7EXAMPLE",
	} {
		if !strings.Contains(secretsText, required) {
			t.Fatalf("secrets.yaml missing %q:\n%s", required, secretsText)
		}
	}
	if !strings.Contains(secretsText, "backup_s3_secret_key:") {
		t.Fatalf("secrets.yaml missing backup_s3_secret_key:\n%s", secretsText)
	}
}

// TestLoadReadsBackupS3FromSecrets is the companion to the strip test: verifies
// that after backup_s3_* migrate to secrets.yaml, Load reads them back correctly
// so that BackupS3AccessKey / BackupS3SecretKey are populated. Without this,
// backup config silently breaks after the first migration. (Decision 3 companion.)
//
// This test writes agent.yaml + secrets.yaml by hand to mirror the on-disk state
// produced by migrateInlineSecretsToSecretFile, then calls Load and asserts
// that the credentials round-trip via the secrets read-back at config.go:265-282.
func TestLoadReadsBackupS3FromSecrets(t *testing.T) {
	defer viper.Reset()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	secretsPath := filepath.Join(dir, "secrets.yaml")

	// agent.yaml after migration: no backup_s3 secrets, has non-secret backup fields.
	agentYAML := `
agent_id: ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776
server_url: https://api.example.test
backup_s3_bucket: my-bucket
backup_s3_region: eu-west-1
`
	if err := os.WriteFile(cfgPath, []byte(agentYAML), 0o644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	// secrets.yaml contains the migrated S3 credentials.
	secretsYAML := `
auth_token: brz_agent_s3
backup_s3_access_key: AKIAIOSFODNN7EXAMPLE
backup_s3_secret_key: wJalrXUtnFEMI/K7MDENG
`
	if err := os.WriteFile(secretsPath, []byte(secretsYAML), 0o600); err != nil {
		t.Fatalf("write secrets.yaml: %v", err)
	}

	loaded, err := Load(cfgPath)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if loaded.BackupS3AccessKey != "AKIAIOSFODNN7EXAMPLE" {
		t.Fatalf("BackupS3AccessKey = %q, want AKIAIOSFODNN7EXAMPLE", loaded.BackupS3AccessKey)
	}
	if loaded.BackupS3SecretKey != "wJalrXUtnFEMI/K7MDENG" {
		t.Fatalf("BackupS3SecretKey = %q, want wJalrXUtnFEMI/K7MDENG", loaded.BackupS3SecretKey)
	}
	// Non-secret fields must also be populated from agent.yaml.
	if loaded.BackupS3Bucket != "my-bucket" {
		t.Fatalf("BackupS3Bucket = %q, want my-bucket", loaded.BackupS3Bucket)
	}
	if loaded.BackupS3Region != "eu-west-1" {
		t.Fatalf("BackupS3Region = %q, want eu-west-1", loaded.BackupS3Region)
	}
}

// TestSaveToFailsWhenSecretsChmodFails verifies Finding #8: SaveTo must return
// an error (not silently log a warning) when the secrets.yaml chmod enforcement
// fails. This prevents a race window where secrets.yaml is world-readable.
func TestSaveToFailsWhenSecretsChmodFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("chmod injection is Unix-only; Windows DACLs covered by permissions_windows_test.go")
	}
	defer viper.Reset()

	// Inject a failing chmod via the package-level var.
	orig := enforceSecretFilePermissions
	defer func() { enforceSecretFilePermissions = orig }()
	enforceSecretFilePermissions = func(path string) error {
		return errors.New("boom: simulated chmod failure")
	}

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent_chmod"

	err := SaveTo(cfg, cfgPath)
	if err == nil {
		t.Fatal("SaveTo returned nil; expected an error when secrets chmod fails")
	}
	if !strings.Contains(err.Error(), "secrets") {
		t.Fatalf("error message does not reference secrets path: %v", err)
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error message does not include the underlying cause: %v", err)
	}
}

// TestStripSecretsFromAgentConfigFailsClosed verifies the strip helper fails
// closed: on a YAML error it returns a wrapped error and NIL data, never the
// original (unstripped) buffer. Previously it silently returned the original
// secret-bearing buffer, which SaveTo then wrote to the 0644 agent.yaml.
func TestStripSecretsFromAgentConfigFailsClosed(t *testing.T) {
	// Malformed YAML (unterminated flow mapping) forces an unmarshal error.
	malformed := []byte("auth_token: brz_super_secret\n{ this: is, not: valid")

	out, err := stripSecretsFromAgentConfig(malformed)
	if err == nil {
		t.Fatal("stripSecretsFromAgentConfig returned nil error on malformed YAML; expected fail-closed error")
	}
	if out != nil {
		t.Fatalf("stripSecretsFromAgentConfig returned non-nil data on error: %q (must never return the unstripped buffer)", out)
	}
	if strings.Contains(string(out), "brz_super_secret") {
		t.Fatal("stripSecretsFromAgentConfig leaked the original secret-bearing buffer on error")
	}
}

// TestSaveToAbortsWhenStripFails verifies the SaveTo fail-closed path: if
// stripping secrets errors (here via the injected marshal hook), SaveTo returns
// an error and does NOT write secrets to the world-readable agent.yaml.
func TestSaveToAbortsWhenStripFails(t *testing.T) {
	defer viper.Reset()

	orig := stripMarshalForTests
	defer func() { stripMarshalForTests = orig }()
	stripMarshalForTests = func(any) ([]byte, error) {
		return nil, errors.New("boom: simulated strip marshal failure")
	}

	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent_strip_secret"

	err := SaveTo(cfg, cfgPath)
	if err == nil {
		t.Fatal("SaveTo returned nil; expected an error when secret stripping fails")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Fatalf("error message does not include the underlying cause: %v", err)
	}

	// agent.yaml must NOT contain the secret. It may not exist at all (write
	// aborted), which is fine — if it does exist, it must not carry the token.
	data, readErr := os.ReadFile(cfgPath)
	if readErr == nil && strings.Contains(string(data), "brz_agent_strip_secret") {
		t.Fatalf("agent.yaml leaked the auth token after a failed strip: %q", data)
	}
}

