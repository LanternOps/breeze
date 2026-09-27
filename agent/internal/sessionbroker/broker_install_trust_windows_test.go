//go:build windows

package sessionbroker

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestTrustedInstallPrincipal(t *testing.T) {
	for _, s := range []string{"S-1-5-18", "S-1-5-32-544", trustedInstallerSID} {
		sid, err := windows.StringToSid(s)
		if err != nil {
			t.Fatal(err)
		}
		if !trustedInstallPrincipal(sid) {
			t.Errorf("%s must be a trusted install principal", s)
		}
	}
	for _, s := range []string{"S-1-5-32-545", "S-1-5-11", "S-1-1-0", "S-1-5-4"} {
		sid, err := windows.StringToSid(s)
		if err != nil {
			t.Fatal(err)
		}
		if trustedInstallPrincipal(sid) {
			t.Errorf("%s must not be a trusted install principal", s)
		}
	}
}

func TestHelperBinaryInstallTrusted_AcceptsSystemBinary(t *testing.T) {
	// %SystemRoot%\System32\cmd.exe is TrustedInstaller-owned and only
	// administrators/TrustedInstaller may modify it or its directory.
	path := filepath.Join(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	if err := helperBinaryInstallTrusted(path); err != nil {
		t.Fatalf("a TrustedInstaller-owned system binary must be trusted: %v", err)
	}
}

func TestHelperBinaryInstallTrusted_RefusesUserWritableDirectory(t *testing.T) {
	// A file under the caller's temp dir: the directory grants the current
	// user (or CREATOR OWNER-derived rights) write access.
	path := filepath.Join(t.TempDir(), "breeze-helper.exe")
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := helperBinaryInstallTrusted(path); err == nil {
		t.Fatal("a helper binary in a user-writable directory must not be treated as an administrator-only install")
	}
}
