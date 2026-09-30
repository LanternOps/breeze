//go:build windows

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// On Windows no file a standard user can read carries the helper token: the
// agent delivers it to the console-session Breeze Assist over IPC only. A
// user-context process reading the config therefore gets no token, even when
// secrets.yaml (SYSTEM/Administrators only) holds one.
func TestWindowsHelperTokenIsNotReadableFromConfigFiles(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")

	cfg := Default()
	cfg.AgentID = "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776"
	cfg.ServerURL = "https://api.example.test"
	cfg.AuthToken = "brz_agent"
	cfg.WatchdogAuthToken = "brz_watchdog"
	cfg.HelperAuthToken = "brz_helper"
	if err := SaveTo(cfg, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}

	helperCfg, err := LoadHelperConfig(cfgPath)
	if err != nil {
		t.Fatalf("LoadHelperConfig: %v", err)
	}
	if helperCfg.HelperAuthToken != "" {
		t.Fatalf("LoadHelperConfig returned a helper token on Windows; it must only arrive over IPC")
	}
	if p := helperTokenFilePathFor(cfgPath); p != "" {
		t.Fatalf("helperTokenFilePathFor = %q, want no helper token file on Windows", p)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == "secrets.yaml" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		if strings.Contains(string(data), "brz_helper") {
			t.Fatalf("%s carries the helper token; only secrets.yaml may", e.Name())
		}
	}
}

// The rotation marker holds no secret, but a standard user must not be able
// to plant or clear it, so it gets the secrets.yaml DACL (no BUILTIN\Users or
// INTERACTIVE ACE).
func TestWindowsHelperTokenRotationMarkerIsPrivate(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(cfgPath, []byte("agent_id: agent-1\nhelper_auth_token: brz_helper_legacy\n"), 0o644); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}

	recordHelperTokenRotationOwed(cfgPath)

	sd, err := windows.GetNamedSecurityInfo(helperTokenRotationMarkerPathFor(cfgPath), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo: %v", err)
	}
	sddl := sd.String()
	for _, sid := range []string{";BU)", ";IU)", ";WD)", ";AU)"} {
		if strings.Contains(sddl, sid) {
			t.Fatalf("rotation marker DACL grants %s: %s", sid, sddl)
		}
	}
}
