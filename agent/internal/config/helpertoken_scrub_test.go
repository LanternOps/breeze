package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

const legacyAgentYAMLWithHelperToken = `agent_id: ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776
server_url: https://api.example.test
helper_auth_token: brz_helper_legacy
log_level: info
`

func writeLegacyAgentYAML(t *testing.T) (dir, cfgPath string) {
	t.Helper()
	dir = t.TempDir()
	cfgPath = filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte(legacyAgentYAMLWithHelperToken), 0o644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	return dir, cfgPath
}

// An older agent left the helper token in agent.yaml. Besides moving it out of
// the file, the scrub records that one credential rotation is owed — durably,
// before it rewrites anything.
func TestFixAgentYAMLPermissionsRecordsRotationOwedForLegacyHelperToken(t *testing.T) {
	tests := []struct {
		name         string
		agentYAML    string
		breakMigrate bool
		wantOwed     bool
		wantScrubbed bool
	}{
		{name: "legacy token is scrubbed and rotation owed", agentYAML: legacyAgentYAMLWithHelperToken, wantOwed: true, wantScrubbed: true},
		{name: "rotation owed even when the scrub itself fails", agentYAML: legacyAgentYAMLWithHelperToken, breakMigrate: true, wantOwed: true},
		{name: "clean agent.yaml owes nothing", agentYAML: "agent_id: agent-1\nserver_url: https://api.example.test\n", wantScrubbed: true},
		{name: "empty token value owes nothing", agentYAML: "agent_id: agent-1\nhelper_auth_token: \"\"\n", wantScrubbed: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			cfgPath := filepath.Join(dir, "agent.yaml")
			if err := os.WriteFile(cfgPath, []byte(tt.agentYAML), 0o644); err != nil {
				t.Fatalf("write agent.yaml: %v", err)
			}
			if tt.breakMigrate {
				// secrets.yaml is a directory: the migration cannot write it.
				if err := os.MkdirAll(filepath.Join(dir, "secrets.yaml"), 0o755); err != nil {
					t.Fatalf("seed secrets.yaml dir: %v", err)
				}
			}

			fixAgentYAMLPermissions(cfgPath)

			_, statErr := os.Stat(helperTokenRotationMarkerPathFor(cfgPath))
			if gotOwed := statErr == nil; gotOwed != tt.wantOwed {
				t.Fatalf("rotation owed marker present = %v, want %v (stat err %v)", gotOwed, tt.wantOwed, statErr)
			}
			data, err := os.ReadFile(cfgPath)
			if err != nil {
				t.Fatalf("read agent.yaml: %v", err)
			}
			if tt.wantScrubbed && strings.Contains(string(data), "helper_auth_token") {
				t.Fatalf("agent.yaml still carries the helper token:\n%s", data)
			}
		})
	}
}

func TestHelperTokenRotationOwedFollowsActiveConfig(t *testing.T) {
	defer viper.Reset()
	_, cfgPath := writeLegacyAgentYAML(t)
	viper.SetConfigFile(cfgPath)

	if HelperTokenRotationOwed() {
		t.Fatal("HelperTokenRotationOwed() = true before any scrub")
	}
	fixAgentYAMLPermissions(cfgPath)
	if !HelperTokenRotationOwed() {
		t.Fatal("HelperTokenRotationOwed() = false after scrubbing a legacy token")
	}
}

// Any verified promotion replaces the legacy token (the server keeps the
// previous one only for its short grace window), so it settles the debt.
func TestPromotePendingCredentialsClearsRotationOwed(t *testing.T) {
	defer viper.Reset()
	_, cfgPath := writeLegacyAgentYAML(t)
	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("Load: %v", err)
	}
	fixAgentYAMLPermissions(cfgPath)
	if !HelperTokenRotationOwed() {
		t.Fatal("precondition: rotation owed after scrub")
	}
	if err := SetSecretAndPersist(secretKeyAuthToken, "brz_current_agent"); err != nil {
		t.Fatalf("seed auth token: %v", err)
	}
	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("PromotePendingCredentials: %v", err)
	}
	if HelperTokenRotationOwed() {
		t.Fatal("rotation still owed after a verified promotion")
	}
}

// Clearing the marker is bookkeeping: failing to delete it must not turn a
// verified promotion into an error (the worst case is one redundant rotation).
func TestPromotePendingCredentialsSucceedsWhenMarkerCannotBeCleared(t *testing.T) {
	defer viper.Reset()
	_, cfgPath := writeLegacyAgentYAML(t)
	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("Load: %v", err)
	}
	marker := helperTokenRotationMarkerPathFor(cfgPath)
	// A non-empty directory cannot be removed with os.Remove.
	if err := os.MkdirAll(filepath.Join(marker, "pinned"), 0o755); err != nil {
		t.Fatalf("seed undeletable marker: %v", err)
	}
	if err := SetSecretAndPersist(secretKeyAuthToken, "brz_current_agent"); err != nil {
		t.Fatalf("seed auth token: %v", err)
	}
	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if !HelperTokenRotationOwed() {
		t.Fatal("precondition: the undeletable marker makes a rotation owed")
	}
	t.Cleanup(resetHelperTokenRotationStateForTest)
	if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("PromotePendingCredentials must not fail on marker cleanup: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("precondition: the marker was supposed to survive the cleanup: %v", err)
	}
	// The rotation has been promoted; a marker that could not be removed must
	// not start another rotation every backoff step for the rest of the run.
	if HelperTokenRotationOwed() {
		t.Fatal("rotation still owed after a verified promotion whose marker could not be removed")
	}
}

// Load runs before the startup scrub, so viper still holds the token an older
// agent wrote. A later single-key persist must never serialize it back into
// agent.yaml — not even transiently before its safety-net migration, which is
// made to fail here so any unfiltered write stays visible on disk.
func TestPersistSettersNeverWriteLoadedSecretsBack(t *testing.T) {
	setters := []struct {
		name string
		set  func() error
	}{
		{name: "SetAndPersist", set: func() error { return SetAndPersist("log_level", "debug") }},
		{name: "SetAllAndPersist", set: func() error {
			return SetAllAndPersist(map[string]any{"log_level": "debug", "server_url": "https://api2.example.test"})
		}},
	}
	for _, tt := range setters {
		t.Run(tt.name, func(t *testing.T) {
			defer viper.Reset()
			dir, cfgPath := writeLegacyAgentYAML(t)
			if _, err := Load(cfgPath); err != nil {
				t.Fatalf("Load: %v", err)
			}
			if err := migrateInlineSecretsToSecretFile(cfgPath); err != nil {
				t.Fatalf("startup scrub: %v", err)
			}
			secretsPath := filepath.Join(dir, "secrets.yaml")
			if err := os.Remove(secretsPath); err != nil {
				t.Fatalf("remove secrets.yaml: %v", err)
			}
			if err := os.MkdirAll(secretsPath, 0o755); err != nil {
				t.Fatalf("seed secrets.yaml dir: %v", err)
			}

			_ = tt.set() // the safety-net migration fails; the write before it must already be clean

			data, err := os.ReadFile(cfgPath)
			if err != nil {
				t.Fatalf("read agent.yaml: %v", err)
			}
			if strings.Contains(string(data), "brz_helper_legacy") || strings.Contains(string(data), "helper_auth_token") {
				t.Fatalf("%s wrote the loaded helper token back into agent.yaml:\n%s", tt.name, data)
			}
			if !strings.Contains(string(data), "log_level: debug") {
				t.Fatalf("%s did not persist the requested key:\n%s", tt.name, data)
			}
		})
	}
}

// Scratch files from an interrupted write of an older agent can still hold a
// token. They are never read back, so startup removes them.
func TestRemoveStaleConfigScratchFiles(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	stale := []string{"agent.yaml.tmp", "agent.yaml.partial", "secrets.yaml.tmp", "secrets.yaml.partial"}
	keep := []string{"agent.yaml", "secrets.yaml", "helper_config.yaml", "agent.yaml.notes"}
	for _, name := range append(append([]string{}, stale...), keep...) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("helper_auth_token: brz_old\n"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
	}

	removeStaleConfigScratchFiles(cfgPath)

	for _, name := range stale {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Errorf("%s still present (err %v)", name, err)
		}
	}
	for _, name := range keep {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s was removed: %v", name, err)
		}
	}
}

// If the marker cannot be written the scrub still goes ahead (removing the
// token from agent.yaml matters more), but the running process must still owe
// the rotation rather than silently forgetting it.
func TestRotationOwedSurvivesAnUnwritableMarker(t *testing.T) {
	defer viper.Reset()
	_, cfgPath := writeLegacyAgentYAML(t)
	if _, err := Load(cfgPath); err != nil {
		t.Fatalf("Load: %v", err)
	}
	// A non-empty directory where the marker's temp file would go makes the
	// marker write fail without touching agent.yaml or secrets.yaml.
	partial := helperTokenRotationMarkerPathFor(cfgPath) + ".partial"
	if err := os.MkdirAll(filepath.Join(partial, "pinned"), 0o755); err != nil {
		t.Fatalf("block marker write: %v", err)
	}
	t.Cleanup(clearHelperTokenRotationOwed)

	fixAgentYAMLPermissions(cfgPath)

	if _, err := os.Stat(helperTokenRotationMarkerPathFor(cfgPath)); err == nil {
		t.Fatal("precondition: the marker write was supposed to fail")
	}
	if data, _ := os.ReadFile(cfgPath); strings.Contains(string(data), "helper_auth_token") {
		t.Fatalf("scrub must still run when the marker cannot be written:\n%s", data)
	}
	if !HelperTokenRotationOwed() {
		t.Fatal("rotation forgotten after the marker write failed")
	}

	if err := SetSecretAndPersist(secretKeyAuthToken, "brz_current_agent"); err != nil {
		t.Fatalf("seed auth token: %v", err)
	}
	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("PromotePendingCredentials: %v", err)
	}
	if HelperTokenRotationOwed() {
		t.Fatal("rotation still owed after a verified promotion")
	}
}

// An agent started with --config elsewhere reads and rewrites that file, so the
// startup pass must scrub it (and clear its scratch files) as well as the
// default agent.yaml.
func TestFixConfigPermissionsScrubsActiveNonDefaultConfig(t *testing.T) {
	defer viper.Reset()
	t.Cleanup(resetHelperTokenRotationStateForTest)
	scratch := []string{"agent.yaml.tmp", "agent.yaml.partial", "secrets.yaml.tmp", "secrets.yaml.partial"}
	seedScratch := func(dir string) {
		t.Helper()
		for _, name := range scratch {
			if err := os.WriteFile(filepath.Join(dir, name), []byte("helper_auth_token: brz_old\n"), 0o600); err != nil {
				t.Fatalf("seed %s: %v", name, err)
			}
		}
	}

	defaultDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(defaultDir, "agent.yaml"), []byte("agent_id: agent-default\n"), 0o644); err != nil {
		t.Fatalf("write default agent.yaml: %v", err)
	}
	seedScratch(defaultDir)
	prevDir := fixConfigPermissionsDir
	fixConfigPermissionsDir = func() string { return defaultDir }
	t.Cleanup(func() { fixConfigPermissionsDir = prevDir })

	activeDir, activeCfg := writeLegacyAgentYAML(t)
	seedScratch(activeDir)
	viper.Reset()
	viper.SetConfigFile(activeCfg)

	FixConfigPermissions()

	data, err := os.ReadFile(activeCfg)
	if err != nil {
		t.Fatalf("read active agent.yaml: %v", err)
	}
	if strings.Contains(string(data), "helper_auth_token") {
		t.Fatalf("active --config agent.yaml still carries the helper token:\n%s", data)
	}
	if _, err := os.Stat(helperTokenRotationMarkerPathFor(activeCfg)); err != nil {
		t.Fatalf("no rotation marker beside the active config: %v", err)
	}
	creds, err := readPersistedCredentialsAt(activeCfg)
	if err != nil || creds == nil || creds.HelperAuthToken != "brz_helper_legacy" {
		t.Fatalf("active secrets.yaml helper token = %+v (err %v), want brz_helper_legacy", creds, err)
	}
	for _, dir := range []string{defaultDir, activeDir} {
		for _, name := range scratch {
			if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
				t.Errorf("%s still present in %s (err %v)", name, dir, err)
			}
		}
	}
}

// When agent.yaml does not parse, only a real helper_auth_token entry makes a
// rotation owed — not the staged pending_ key, a comment, or an empty value.
func TestUnparsableAgentYAMLOwesRotationOnlyForARealHelperToken(t *testing.T) {
	const broken = "server_url: [unclosed\n"
	tests := []struct {
		name     string
		body     string
		wantOwed bool
	}{
		{name: "helper token entry", body: "helper_auth_token: brz_helper_legacy\n", wantOwed: true},
		{name: "quoted helper token entry", body: "  \"helper_auth_token\": 'brz_helper_legacy'\n", wantOwed: true},
		{name: "pending key only", body: "pending_helper_auth_token: brz_new_helper\n"},
		{name: "comment only", body: "# helper_auth_token: brz_helper_legacy\n"},
		{name: "empty value", body: "helper_auth_token: \"\"\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Cleanup(resetHelperTokenRotationStateForTest)
			cfgPath := filepath.Join(t.TempDir(), "agent.yaml")
			if err := os.WriteFile(cfgPath, []byte("agent_id: agent-1\n"+tt.body+broken), 0o644); err != nil {
				t.Fatalf("write agent.yaml: %v", err)
			}
			if err := migrateInlineSecretsToSecretFile(cfgPath); err == nil {
				t.Fatal("precondition: agent.yaml was supposed to fail to parse")
			}
			_, statErr := os.Stat(helperTokenRotationMarkerPathFor(cfgPath))
			if got := statErr == nil || helperTokenRotationOwedInProcess.Load(); got != tt.wantOwed {
				t.Fatalf("rotation owed = %v, want %v", got, tt.wantOwed)
			}
		})
	}
}

// A token left in agent.yaml that a later rotation has already replaced (for
// example while agent.yaml could not be rewritten) is removed without owing
// another rotation; one that is still current or staged is not.
func TestScrubOwesRotationOnlyForAStillValidHelperToken(t *testing.T) {
	tests := []struct {
		name     string
		secrets  string
		wantOwed bool
	}{
		{name: "matches current", secrets: "helper_auth_token: brz_helper_legacy\n", wantOwed: true},
		{name: "matches staged", secrets: "helper_auth_token: brz_helper_newer\npending_helper_auth_token: brz_helper_legacy\n", wantOwed: true},
		{name: "no helper token in secrets.yaml", secrets: "auth_token: brz_agent\n", wantOwed: true},
		{name: "already replaced", secrets: "helper_auth_token: brz_helper_newer\n", wantOwed: false},
		{name: "already replaced, other staged", secrets: "helper_auth_token: brz_helper_newer\npending_helper_auth_token: brz_helper_staged\n", wantOwed: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Cleanup(resetHelperTokenRotationStateForTest)
			dir, cfgPath := writeLegacyAgentYAML(t)
			if err := os.WriteFile(filepath.Join(dir, "secrets.yaml"), []byte(tt.secrets), 0o600); err != nil {
				t.Fatalf("write secrets.yaml: %v", err)
			}

			fixAgentYAMLPermissions(cfgPath)

			if data, _ := os.ReadFile(cfgPath); strings.Contains(string(data), "helper_auth_token") {
				t.Fatalf("agent.yaml still carries the helper token:\n%s", data)
			}
			_, statErr := os.Stat(helperTokenRotationMarkerPathFor(cfgPath))
			if got := statErr == nil || helperTokenRotationOwedInProcess.Load(); got != tt.wantOwed {
				t.Fatalf("rotation owed = %v, want %v", got, tt.wantOwed)
			}
		})
	}
}
