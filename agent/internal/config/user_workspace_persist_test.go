package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// #7629: a Quick Support session enrolls into its own workspace, but nothing
// used to make that workspace's agent.yaml the active config file. Every
// mid-session persist (token rotation, mTLS renewal, manifest-key pinning,
// SetAndPersist) resolved an empty active file to the machine-wide config dir,
// which a standard user cannot write and which, for an elevated administrator,
// is the installed agent's own agent.yaml / secrets.yaml.

// plantInstalledAgentConfig stands a temp dir in for the installed agent's
// machine-wide config dir and fills it with that agent's identity. It returns
// the dir and a snapshot for assertInstalledConfigUntouched.
func plantInstalledAgentConfig(t *testing.T) (string, map[string]string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "ProgramData-Breeze")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"agent.yaml":   "agent_id: installed-agent-id\nserver_url: https://installed.example.test\ndevice_id: installed-device\n",
		"secrets.yaml": "auth_token: brz_installed_agent\nwatchdog_auth_token: brz_installed_watchdog\nhelper_auth_token: brz_installed_helper\n",
	}
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(SetConfigDirForTest(dir))
	if got := ConfigDir(); got != dir {
		t.Fatalf("ConfigDir() = %q after SetConfigDirForTest(%q)", got, dir)
	}
	return dir, snapshotDir(t, dir)
}

func snapshotDir(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	snap := map[string]string{}
	for _, e := range entries {
		body, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		snap[e.Name()] = string(body)
	}
	return snap
}

func assertInstalledConfigUntouched(t *testing.T, dir string, want map[string]string) {
	t.Helper()
	got := snapshotDir(t, dir)
	var names []string
	for name := range got {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(got) != len(want) {
		t.Errorf("installed agent config dir now holds %v, want only the planted agent.yaml and secrets.yaml", names)
	}
	for name, body := range want {
		if got[name] != body {
			t.Errorf("installed agent's %s was rewritten:\n got: %q\nwant: %q", name, got[name], body)
		}
	}
}

// enrollIntoSupportWorkspace does what runSupportSession does up to and
// including enrollment: register the workspace, then SaveEnrollment into it.
// The active config file is left unbound, as it was before #7629.
func enrollIntoSupportWorkspace(t *testing.T) (string, *Config) {
	t.Helper()
	t.Cleanup(resetUserWorkspaceForTest)
	viper.Reset()
	t.Cleanup(viper.Reset)

	ws := filepath.Join(t.TempDir(), "breeze-support-7629")
	if err := SecureUserWorkspace(ws); err != nil {
		t.Fatalf("SecureUserWorkspace: %v", err)
	}
	cfgPath := filepath.Join(ws, "agent.yaml")
	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.DeviceID = "support-device"
	cfg.AuthToken = "brz_support_agent"
	cfg.WatchdogAuthToken = "brz_support_watchdog"
	cfg.HelperAuthToken = "brz_support_helper"
	cfg.MtlsCertPEM = "support-cert"
	cfg.MtlsKeyPEM = "support-key"
	if err := SaveEnrollment(cfg, cfgPath); err != nil {
		t.Fatalf("SaveEnrollment into the workspace: %v", err)
	}
	if got := ActiveConfigFile(); got != "" {
		t.Fatalf("ActiveConfigFile() = %q before binding, want empty (the support session's state after enrollment)", got)
	}
	return cfgPath, cfg
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func readCreds(t *testing.T, cfgPath string) *PersistedCredentials {
	t.Helper()
	creds, err := readPersistedCredentialsAt(cfgPath)
	if err != nil {
		t.Fatalf("read the workspace secrets.yaml: %v", err)
	}
	return creds
}

// TestUserWorkspaceSupportSessionPersistsOnlyToItsWorkspace is the #7629
// acceptance test. After the support session binds its workspace agent.yaml,
// every mid-session persist path writes there, and an installed agent's config
// at the default path is byte-for-byte untouched.
func TestUserWorkspaceSupportSessionPersistsOnlyToItsWorkspace(t *testing.T) {
	installedDir, installed := plantInstalledAgentConfig(t)
	cfgPath, cfg := enrollIntoSupportWorkspace(t)

	if err := BindConfigFile(cfgPath); err != nil {
		t.Fatalf("BindConfigFile(workspace agent.yaml): %v", err)
	}
	if got := ActiveConfigFile(); !samePath(got, cfgPath) {
		t.Fatalf("ActiveConfigFile() = %q after BindConfigFile, want %q", got, cfgPath)
	}

	// Token rotation, phase 1: stage alongside the current set.
	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	if got := readCreds(t, cfgPath); got.PendingAuthToken != "brz_new_agent" || got.AuthToken != "brz_support_agent" {
		t.Fatalf("after staging, workspace creds = current %q pending %q", got.AuthToken, got.PendingAuthToken)
	}
	// Phase 2: promote once the server confirms.
	if err := PromotePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("PromotePendingCredentials: %v", err)
	}
	if got := readCreds(t, cfgPath); got.AuthToken != "brz_new_agent" || got.PendingAuthToken != "" {
		t.Fatalf("after promotion, workspace creds = current %q pending %q", got.AuthToken, got.PendingAuthToken)
	}
	// An expired staged set is cleared.
	if err := StagePendingCredentials("brz_next_agent", "brz_next_watchdog", "brz_next_helper"); err != nil {
		t.Fatalf("StagePendingCredentials (second rotation): %v", err)
	}
	if err := ClearPendingCredentials(); err != nil {
		t.Fatalf("ClearPendingCredentials: %v", err)
	}
	if got := readCreds(t, cfgPath); got.PendingAuthToken != "" || got.AuthToken != "brz_new_agent" {
		t.Fatalf("after clearing, workspace creds = current %q pending %q", got.AuthToken, got.PendingAuthToken)
	}

	// mTLS renewal: the heartbeat saves its config to ActiveConfigFile().
	cfg.MtlsCertPEM = "renewed-cert"
	cfg.MtlsKeyPEM = "renewed-key"
	if err := SaveTo(cfg, ActiveConfigFile()); err != nil {
		t.Fatalf("SaveTo(cfg, ActiveConfigFile()): %v", err)
	}

	// Heartbeat-driven config updates and manifest-key pinning.
	if err := SetAndPersist("auto_update", false); err != nil {
		t.Fatalf("SetAndPersist: %v", err)
	}
	if err := SetAllAndPersist(map[string]any{"backup_server_url": "https://backup.example.test"}); err != nil {
		t.Fatalf("SetAllAndPersist: %v", err)
	}
	if err := SetSecretAndPersist("backup_s3_secret_key", "support-s3-secret"); err != nil {
		t.Fatalf("SetSecretAndPersist: %v", err)
	}
	if err := PinManifestKeys(ActiveConfigFile(), []ManifestTrustKey{{KeyID: "deploy-a", PublicKeyB64: testPubKey(7)}}); err != nil {
		t.Fatalf("PinManifestKeys(ActiveConfigFile()): %v", err)
	}

	reloaded, err := Reload()
	if err != nil {
		t.Fatalf("Reload: %v", err)
	}
	if got := ActiveConfigFile(); !samePath(got, cfgPath) {
		t.Errorf("ActiveConfigFile() = %q after the session's writes, want %q", got, cfgPath)
	}
	if reloaded.AgentID != cfg.AgentID || reloaded.DeviceID != "support-device" {
		t.Errorf("reloaded identity = agent %q device %q, want the support session's", reloaded.AgentID, reloaded.DeviceID)
	}
	if reloaded.AuthToken != "brz_new_agent" {
		t.Errorf("reloaded auth token = %q, want the promoted brz_new_agent", reloaded.AuthToken)
	}
	if reloaded.MtlsCertPEM != "renewed-cert" {
		t.Errorf("reloaded mTLS cert = %q, want renewed-cert", reloaded.MtlsCertPEM)
	}
	if reloaded.BackupServerURL != "https://backup.example.test" || reloaded.BackupS3SecretKey != "support-s3-secret" {
		t.Errorf("reloaded backup url %q / s3 secret %q not persisted to the workspace", reloaded.BackupServerURL, reloaded.BackupS3SecretKey)
	}
	if len(reloaded.PinnedManifestPubKeys) != 1 {
		t.Errorf("reloaded pinned manifest keys = %v, want the one pinned key", reloaded.PinnedManifestPubKeys)
	}

	// Bound, an explicit outside path is still refused and does not rebind.
	installedCfg := filepath.Join(installedDir, "agent.yaml")
	if _, err := Load(installedCfg); !errors.Is(err, ErrConfigOutsideUserWorkspace) {
		t.Errorf("Load(installed agent.yaml) while bound: err = %v, want ErrConfigOutsideUserWorkspace", err)
	}
	if err := BindConfigFile(installedCfg); !errors.Is(err, ErrConfigOutsideUserWorkspace) {
		t.Errorf("BindConfigFile(installed agent.yaml) while bound: err = %v, want ErrConfigOutsideUserWorkspace", err)
	}
	if err := SaveTo(cfg, installedCfg); !errors.Is(err, ErrConfigOutsideUserWorkspace) {
		t.Errorf("SaveTo(installed agent.yaml) while bound: err = %v, want ErrConfigOutsideUserWorkspace", err)
	}
	if got := ActiveConfigFile(); !samePath(got, cfgPath) {
		t.Errorf("ActiveConfigFile() = %q after refused outside calls, want still %q", got, cfgPath)
	}

	assertInstalledConfigUntouched(t, installedDir, installed)
}

// TestUserWorkspaceRefusesConfigOutsideIt: once a process has registered a
// user workspace, a load or persist aimed at a path outside it fails closed,
// and a load with nothing bound is refused rather than searched for. The
// installed agent's config is left byte-for-byte as it was.
func TestUserWorkspaceRefusesConfigOutsideIt(t *testing.T) {
	installedDir, installed := plantInstalledAgentConfig(t)
	cfgPath, cfg := enrollIntoSupportWorkspace(t)
	installedCfg := filepath.Join(installedDir, "agent.yaml")
	elsewhere := filepath.Join(t.TempDir(), "agent.yaml")
	keys := []ManifestTrustKey{{KeyID: "deploy-a", PublicKeyB64: testPubKey(7)}}

	for _, tc := range []struct {
		name string
		op   func() error
	}{
		{"SaveTo(another dir)", func() error { return SaveTo(cfg, elsewhere) }},
		{"SaveTo(installed agent.yaml)", func() error { return SaveTo(cfg, installedCfg) }},
		{"SaveEnrollment(installed agent.yaml)", func() error { return SaveEnrollment(cfg, installedCfg) }},
		{"PrepareSaveDir(installed agent.yaml)", func() error { return PrepareSaveDir(installedCfg) }},
		{"PinManifestKeys(installed agent.yaml)", func() error { return PinManifestKeys(installedCfg, keys) }},
		{"Load(installed agent.yaml)", func() error { _, err := Load(installedCfg); return err }},
		{"BindConfigFile(installed agent.yaml)", func() error { return BindConfigFile(installedCfg) }},
		// Nothing bound: a load must be explicit, not a search.
		{"Load(default)", func() error { _, err := Load(""); return err }},
		{"Reload (unbound)", func() error { _, err := Reload(); return err }},
		{"SetAndPersist (unbound)", func() error { return SetAndPersist("auto_update", false) }},
		{"SetAllAndPersist (unbound)", func() error { return SetAllAndPersist(map[string]any{"auto_update": false}) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.op(); !errors.Is(err, ErrConfigOutsideUserWorkspace) {
				t.Errorf("err = %v, want ErrConfigOutsideUserWorkspace", err)
			}
			// A refused load must not rebind the process to the installed
			// agent's agent.yaml: every later write would follow it there.
			if got := ActiveConfigFile(); got != "" {
				t.Errorf("ActiveConfigFile() = %q after a refused call, want still unbound", got)
			}
		})
	}

	if _, err := os.Stat(elsewhere); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("a config was written outside the workspace at %s (stat err %v)", elsewhere, err)
	}
	if got := readCreds(t, cfgPath); got.AuthToken != "brz_support_agent" || got.PendingAuthToken != "" {
		t.Errorf("refused calls changed the workspace creds: current %q pending %q", got.AuthToken, got.PendingAuthToken)
	}
	assertInstalledConfigUntouched(t, installedDir, installed)
}

// TestUserWorkspaceUnboundDefaultsLandInIt is the state the support session
// was in before #7629: enrolled into its folder, nothing bound. Every persist
// that resolves the default path used to land in the machine-wide config dir.
// The default paths now resolve inside the support folder, so these land in
// the session's own files, and the installed agent's config is untouched.
func TestUserWorkspaceUnboundDefaultsLandInIt(t *testing.T) {
	installedDir, installed := plantInstalledAgentConfig(t)
	cfgPath, cfg := enrollIntoSupportWorkspace(t)

	if err := StagePendingCredentials("brz_new_agent", "brz_new_watchdog", "brz_new_helper"); err != nil {
		t.Fatalf("StagePendingCredentials (unbound): %v", err)
	}
	if got := readCreds(t, cfgPath); got.PendingAuthToken != "brz_new_agent" {
		t.Errorf("staged token in the support folder = %q, want brz_new_agent", got.PendingAuthToken)
	}
	if err := ClearPendingCredentials(); err != nil {
		t.Fatalf("ClearPendingCredentials (unbound): %v", err)
	}
	if err := SetSecretAndPersist("backup_s3_secret_key", "support-s3-secret"); err != nil {
		t.Fatalf("SetSecretAndPersist (unbound): %v", err)
	}
	cfg.MtlsCertPEM = "renewed-cert"
	if err := SaveTo(cfg, ActiveConfigFile()); err != nil {
		t.Fatalf("SaveTo(cfg, ActiveConfigFile()) unbound: %v", err)
	}
	if err := Save(cfg); err != nil {
		t.Fatalf("Save (unbound): %v", err)
	}
	if err := PrepareSaveDir(""); err != nil {
		t.Fatalf("PrepareSaveDir(default): %v", err)
	}
	creds, err := ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials (unbound): %v", err)
	}
	if creds.AuthToken != "brz_support_agent" || creds.PendingAuthToken != "" {
		t.Errorf("support folder creds = current %q pending %q, want the enrolled token and none pending", creds.AuthToken, creds.PendingAuthToken)
	}
	assertInstalledConfigUntouched(t, installedDir, installed)
}

// TestUserWorkspaceBindConfigFileRequiresTheEnrolledFile: binding a workspace
// path that holds no agent.yaml fails rather than binding an empty config
// (whose first SaveTo would write a config with no identity).
func TestUserWorkspaceBindConfigFileRequiresTheEnrolledFile(t *testing.T) {
	cfgPath, _ := enrollIntoSupportWorkspace(t)
	missing := filepath.Join(filepath.Dir(cfgPath), "not-enrolled.yaml")
	if err := BindConfigFile(missing); err == nil {
		t.Fatal("BindConfigFile on a missing file succeeded")
	}
	if got := ActiveConfigFile(); got != "" {
		t.Errorf("ActiveConfigFile() = %q after a failed bind, want still unbound", got)
	}
}
