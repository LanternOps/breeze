//go:build windows

package config

import (
	"errors"
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

func TestMainAgentDirectorySDDLs(t *testing.T) {
	const wantConfig = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;FRFX;;;BU)"
	const wantRun = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	if windowsConfigDirCreateSDDL != wantConfig {
		t.Fatalf("config creation SDDL = %q, want %q", windowsConfigDirCreateSDDL, wantConfig)
	}
	if windowsAgentRunDirSDDL != wantRun {
		t.Fatalf("run directory SDDL = %q, want %q", windowsAgentRunDirSDDL, wantRun)
	}
	for name, sddl := range map[string]string{"config": wantConfig, "run": wantRun} {
		if _, err := windows.SecurityDescriptorFromString(sddl); err != nil {
			t.Fatalf("%s SDDL does not parse: %v", name, err)
		}
	}
}

func TestPrepareMainAgentLockDirRejectsReparseParent(t *testing.T) {
	dir := t.TempDir()
	restoreMainAgentDirectorySeams(t, dir)
	getMainAgentFileInformationFn = func(_ windows.Handle, info *windows.ByHandleFileInformation) error {
		info.FileAttributes = windows.FILE_ATTRIBUTE_DIRECTORY | windows.FILE_ATTRIBUTE_REPARSE_POINT
		return nil
	}

	_, err := PrepareMainAgentLockDir()
	assertMainAgentSecurityError(t, err)
}

func TestPrepareMainAgentLockDirRejectsUntrustedOwner(t *testing.T) {
	dir := t.TempDir()
	restoreMainAgentDirectorySeams(t, dir)
	untrusted := mustWindowsSecurityDescriptor(t, "O:BUD:P(A;;FA;;;BU)")
	setMainAgentSecurityInfoFn = func(windows.Handle, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION, *windows.SID, *windows.SID, *windows.ACL, *windows.ACL) error {
		return nil
	}
	getMainAgentSecurityInfoFn = func(windows.Handle, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION) (*windows.SECURITY_DESCRIPTOR, error) {
		return untrusted, nil
	}

	_, err := PrepareMainAgentLockDir()
	assertMainAgentSecurityError(t, err)
}

func TestPrepareMainAgentLockDirSanitizesUntrustedExistingRunDir(t *testing.T) {
	dir := t.TempDir()
	runDir := filepath.Join(dir, "run")
	if err := os.Mkdir(runDir, 0o700); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(runDir, "agent.lock")
	if err := os.WriteFile(lockPath, []byte("hostile"), 0o600); err != nil {
		t.Fatal(err)
	}
	restoreMainAgentDirectorySeams(t, dir)
	trustedConfig := mustWindowsSecurityDescriptor(t, windowsConfigDirCreateSDDL)
	trustedRun := mustWindowsSecurityDescriptor(t, windowsAgentRunDirSDDL)
	untrusted := mustWindowsSecurityDescriptor(t, "O:BUD:P(A;;FA;;;BU)")
	securityRead := 0
	getMainAgentSecurityInfoFn = func(windows.Handle, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION) (*windows.SECURITY_DESCRIPTOR, error) {
		securityRead++
		switch securityRead {
		case 1:
			return trustedConfig, nil
		case 2: // Existing run directory before handle-based repair.
			return untrusted, nil
		default:
			return trustedRun, nil
		}
	}
	removed := false
	removeMainAgentLockRelativeFn = func(_ windows.Handle, name string) error {
		if name != "agent.lock" {
			t.Fatalf("removed relative name = %q", name)
		}
		removed = true
		return os.Remove(lockPath)
	}

	got, err := PrepareMainAgentLockDir()
	if err != nil {
		t.Fatal(err)
	}
	if got != runDir {
		t.Fatalf("lock dir = %q, want %q", got, runDir)
	}
	if !removed {
		t.Fatal("hostile existing agent.lock was not sanitized")
	}
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("hostile lock remains: %v", err)
	}
}

func TestPrepareMainAgentLockDirDetectsParentSwap(t *testing.T) {
	dir := t.TempDir()
	restoreMainAgentDirectorySeams(t, dir)
	infoRead := 0
	getMainAgentFileInformationFn = func(_ windows.Handle, info *windows.ByHandleFileInformation) error {
		infoRead++
		info.FileAttributes = windows.FILE_ATTRIBUTE_DIRECTORY
		info.VolumeSerialNumber = 7
		info.FileIndexLow = uint32(infoRead) // Reopen resolves to a different object.
		return nil
	}

	_, err := PrepareMainAgentLockDir()
	assertMainAgentSecurityError(t, err)
}

func TestPrepareMainAgentLockDirDACLFailureIsSecurityError(t *testing.T) {
	dir := t.TempDir()
	restoreMainAgentDirectorySeams(t, dir)
	wantErr := errors.New("injected SetSecurityInfo failure")
	setMainAgentSecurityInfoFn = func(_ windows.Handle, objectType windows.SE_OBJECT_TYPE, info windows.SECURITY_INFORMATION, _ *windows.SID, _ *windows.SID, _ *windows.ACL, _ *windows.ACL) error {
		if objectType != windows.SE_FILE_OBJECT {
			t.Fatalf("object type = %v", objectType)
		}
		const want = windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION | windows.PROTECTED_DACL_SECURITY_INFORMATION
		if info != want {
			t.Fatalf("security information = %#x, want %#x", info, want)
		}
		return wantErr
	}

	_, err := PrepareMainAgentLockDir()
	assertMainAgentSecurityError(t, err)
	if !errors.Is(err, wantErr) {
		t.Fatalf("error = %v, want wrapped injected error", err)
	}
}

func TestOpenPreparedMainAgentLockDirKeepsVerifiedHandleLive(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "run"), 0o700); err != nil {
		t.Fatal(err)
	}
	restoreMainAgentDirectorySeams(t, dir)

	pinned, err := OpenPreparedMainAgentLockDir()
	if err != nil {
		t.Fatal(err)
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(pinned.Handle(), &info); err != nil {
		t.Fatalf("returned run handle is not live: %v", err)
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		t.Fatalf("returned handle attributes = %#x", info.FileAttributes)
	}
	if err := pinned.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pinned.Close(); err != nil {
		t.Fatalf("idempotent close: %v", err)
	}
}

func restoreMainAgentDirectorySeams(t *testing.T, dir string) {
	t.Helper()
	oldConfigDir := mainAgentConfigDirFn
	oldFileInfo := getMainAgentFileInformationFn
	oldGetSecurity := getMainAgentSecurityInfoFn
	oldSetSecurity := setMainAgentSecurityInfoFn
	oldRemoveLock := removeMainAgentLockRelativeFn
	t.Cleanup(func() {
		mainAgentConfigDirFn = oldConfigDir
		getMainAgentFileInformationFn = oldFileInfo
		getMainAgentSecurityInfoFn = oldGetSecurity
		setMainAgentSecurityInfoFn = oldSetSecurity
		removeMainAgentLockRelativeFn = oldRemoveLock
	})
	mainAgentConfigDirFn = func() string { return dir }
	trustedConfig := mustWindowsSecurityDescriptor(t, windowsConfigDirCreateSDDL)
	trustedRun := mustWindowsSecurityDescriptor(t, windowsAgentRunDirSDDL)
	securityRead := 0
	getMainAgentSecurityInfoFn = func(windows.Handle, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION) (*windows.SECURITY_DESCRIPTOR, error) {
		securityRead++
		if securityRead == 1 {
			return trustedConfig, nil
		}
		return trustedRun, nil
	}
	setMainAgentSecurityInfoFn = func(windows.Handle, windows.SE_OBJECT_TYPE, windows.SECURITY_INFORMATION, *windows.SID, *windows.SID, *windows.ACL, *windows.ACL) error {
		return nil
	}
}

func mustWindowsSecurityDescriptor(t *testing.T, sddl string) *windows.SECURITY_DESCRIPTOR {
	t.Helper()
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	return sd
}

func assertMainAgentSecurityError(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("expected fail-closed security error")
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
