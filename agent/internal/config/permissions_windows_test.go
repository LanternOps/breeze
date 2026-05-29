//go:build windows

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// TestWindowsConfigDACLGrantsUsersRead locks the invariants behind the
// "Breeze Assist requires the Breeze agent..." regression: agent.yaml and its
// directory must grant BUILTIN\Users read (so the Helper, running as the
// logged-in user, can read them), while secrets.yaml must NOT — the full
// agent/watchdog tokens and mTLS keys stay SYSTEM + Administrators only.
func TestWindowsConfigDACLGrantsUsersRead(t *testing.T) {
	if !strings.Contains(windowsConfigFileSDDL, "(A;;FR;;;BU)") {
		t.Errorf("agent.yaml DACL must grant BUILTIN\\Users read: %s", windowsConfigFileSDDL)
	}
	if !strings.Contains(windowsConfigDirSDDL, ";BU)") {
		t.Errorf("config dir DACL must grant BUILTIN\\Users read+traverse: %s", windowsConfigDirSDDL)
	}
	if strings.Contains(windowsSecretFileSDDL, "BU") || strings.Contains(windowsSecretFileSDDL, "IU") {
		t.Errorf("secrets.yaml DACL must NOT grant Users/Interactive access: %s", windowsSecretFileSDDL)
	}
	// All three must be PROTECTED (D:P) so inherited ACEs can't widen access.
	for name, sddl := range map[string]string{
		"dir":     windowsConfigDirSDDL,
		"config":  windowsConfigFileSDDL,
		"secrets": windowsSecretFileSDDL,
	} {
		if !strings.HasPrefix(sddl, "D:P") {
			t.Errorf("%s DACL must be PROTECTED (D:P prefix): %s", name, sddl)
		}
		// Every DACL string must parse as a valid security descriptor.
		if _, err := windows.SecurityDescriptorFromString(sddl); err != nil {
			t.Errorf("%s DACL does not parse: %v", name, err)
		}
	}
}

// TestEnforceConfigFileDACLAppliesUsersRead applies the real DACL to a temp file
// and reads it back, confirming a Users (BU) ACE is present on agent.yaml and
// absent on secrets.yaml.
func TestEnforceConfigFileDACLAppliesUsersRead(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(cfgPath, []byte("server_url: x\n"), 0o600); err != nil {
		t.Fatalf("write agent.yaml: %v", err)
	}
	if err := os.WriteFile(secretsPath, []byte("auth_token: x\n"), 0o600); err != nil {
		t.Fatalf("write secrets.yaml: %v", err)
	}

	if err := enforceConfigFilePermissions(cfgPath); err != nil {
		t.Fatalf("enforceConfigFilePermissions: %v", err)
	}
	if err := enforceSecretFilePermissions(secretsPath); err != nil {
		t.Fatalf("enforceSecretFilePermissions: %v", err)
	}

	usersSID, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil {
		t.Fatalf("CreateWellKnownSid: %v", err)
	}

	if !daclGrantsSID(t, cfgPath, usersSID) {
		t.Errorf("agent.yaml DACL does not grant BUILTIN\\Users; Helper cannot read it")
	}
	if daclGrantsSID(t, secretsPath, usersSID) {
		t.Errorf("secrets.yaml DACL grants BUILTIN\\Users; real secrets are exposed")
	}
}

// daclGrantsSID reports whether the file's DACL contains an allow ACE for sid.
func daclGrantsSID(t *testing.T, path string, sid *windows.SID) bool {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION,
	)
	if err != nil {
		t.Fatalf("GetNamedSecurityInfo(%s): %v", path, err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatalf("DACL(%s): %v", path, err)
	}
	if dacl == nil {
		return false
	}
	for i := uint32(0); i < uint32(dacl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(dacl, i, &ace); err != nil {
			continue
		}
		aceSID := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if aceSID.Equals(sid) {
			return true
		}
	}
	return false
}
