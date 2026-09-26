package helper

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// #6868: when Windows Installer already has the helper product registered at
// the target version but breeze-helper.exe on disk is older (a 3010 install
// whose file replacement was deferred to reboot, or the agent's own file-level
// rollback after a successful msiexec), `msiexec /i` runs a maintenance
// reconfigure of the registered product, replaces no files, and exits 1603 on
// every retry. The retry must force a file reinstall instead.

func TestInstallMSIForcesReinstallWhenRegisteredAtTarget(t *testing.T) {
	f := &fakeMSI{binaryPresent: true, productCode: "{ABC}", productVersion: "0.116.0"}
	if err := installMSI("pkg.msi", "bin", "0.116.0", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "reinstall:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v (a registered-at-target product needs reinstall semantics, not /i)", f.calls, want)
	}
}

func TestInstallMSIReinstallMatchesVersionCore(t *testing.T) {
	cases := []struct {
		name       string
		registered string
		target     string
	}{
		{"prerelease target", "0.116.0", "0.116.0-rc.1"},
		{"four-part registered version", "0.116.0.0", "0.116.0"},
		{"v-prefixed target", "0.116.0", "v0.116.0"},
		{"whitespace in registry value", " 0.116.0 ", "0.116.0"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeMSI{binaryPresent: true, productCode: "{ABC}", productVersion: tc.registered}
			if err := installMSI("pkg.msi", "bin", tc.target, f.ops()); err != nil {
				t.Fatalf("installMSI: %v", err)
			}
			want := []string{"stat", "find", "reinstall:pkg.msi"}
			if !reflect.DeepEqual(f.calls, want) {
				t.Fatalf("calls=%v, want %v", f.calls, want)
			}
		})
	}
}

func TestInstallMSIPlainInstallWhenRegisteredVersionDiffers(t *testing.T) {
	cases := []struct {
		name       string
		registered string
	}{
		{"older registration (normal upgrade)", "0.115.0"},
		{"newer registration", "0.117.0"},
		{"unreadable DisplayVersion", ""},
		{"garbage DisplayVersion", "not-a-version"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeMSI{binaryPresent: true, productCode: "{ABC}", productVersion: tc.registered}
			if err := installMSI("pkg.msi", "bin", "0.116.0", f.ops()); err != nil {
				t.Fatalf("installMSI: %v", err)
			}
			want := []string{"stat", "find", "install:pkg.msi"}
			if !reflect.DeepEqual(f.calls, want) {
				t.Fatalf("calls=%v, want %v", f.calls, want)
			}
		})
	}
}

func TestInstallMSIPlainInstallWhenBinaryPresentAndNothingRegistered(t *testing.T) {
	f := &fakeMSI{binaryPresent: true}
	if err := installMSI("pkg.msi", "bin", "0.116.0", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

func TestInstallMSIPlainInstallWhenBinaryPresentAndLookupFails(t *testing.T) {
	f := &fakeMSI{binaryPresent: true, findErr: errors.New("access denied")}
	if err := installMSI("pkg.msi", "bin", "0.116.0", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

// The registered same-version product may come from a different build than the
// downloaded package (a different ProductCode). The repair then reports the
// package's product as not installed (1605), and a plain /i is the right
// install for it.
func TestInstallMSIFallsBackToInstallWhenReinstallTargetsUnknownProduct(t *testing.T) {
	f := &fakeMSI{
		binaryPresent:  true,
		productCode:    "{ABC}",
		productVersion: "0.116.0",
		reinstallErr:   fmt.Errorf("msiexec /f: %w", errMSIProductNotInstalled),
	}
	if err := installMSI("pkg.msi", "bin", "0.116.0", f.ops()); err != nil {
		t.Fatalf("installMSI: %v", err)
	}
	want := []string{"stat", "find", "reinstall:pkg.msi", "install:pkg.msi"}
	if !reflect.DeepEqual(f.calls, want) {
		t.Fatalf("calls=%v, want %v", f.calls, want)
	}
}

func TestInstallMSIReturnsReinstallFailure(t *testing.T) {
	f := &fakeMSI{
		binaryPresent:  true,
		productCode:    "{ABC}",
		productVersion: "0.116.0",
		reinstallErr:   errors.New("exit status 1603"),
	}
	err := installMSI("pkg.msi", "bin", "0.116.0", f.ops())
	if err == nil || !strings.Contains(err.Error(), "1603") {
		t.Fatalf("err=%v, want the reinstall failure", err)
	}
	for _, c := range f.calls {
		if strings.HasPrefix(c, "install:") || strings.HasPrefix(c, "uninstall:") {
			t.Fatalf("unexpected %q after a reinstall failure: %v", c, f.calls)
		}
	}
}

// The target version must reach the platform installer: without it the
// Windows installer cannot tell a registered-at-target product (#6868) from a
// normal upgrade.
func TestDownloadAndInstallPassesTargetVersionToInstaller(t *testing.T) {
	tmpDir := t.TempDir()
	mgr := newInstallTestManager(t, tmpDir)
	pkg := filepath.Join(tmpDir, "verified"+packageExtension())
	mgr.downloadFunc = func(string) (string, error) {
		if err := os.WriteFile(pkg, []byte("VERIFIED"), 0600); err != nil {
			return "", err
		}
		return pkg, nil
	}

	var got []string
	orig := installPackageFunc
	t.Cleanup(func() { installPackageFunc = orig })
	installPackageFunc = func(_, _, version string) error {
		got = append(got, version)
		return nil
	}

	if err := mgr.downloadAndInstall("0.116.0"); err != nil {
		t.Fatalf("downloadAndInstall: %v", err)
	}
	if !reflect.DeepEqual(got, []string{"0.116.0"}) {
		t.Fatalf("installer got versions %v, want [0.116.0]", got)
	}
}

// runMSIReinstall's exit-code mapping, testable off Windows.
func TestMSIReinstallExitError(t *testing.T) {
	cause := errors.New("exit status N")
	if err := msiReinstallExitError(3010, cause, ""); err != nil {
		t.Fatalf("3010 (reboot required) must be success, got %v", err)
	}
	if err := msiReinstallExitError(1605, cause, "out"); !errors.Is(err, errMSIProductNotInstalled) {
		t.Fatalf("1605 must map to errMSIProductNotInstalled, got %v", err)
	}
	err := msiReinstallExitError(1603, cause, "log text")
	if err == nil || errors.Is(err, errMSIProductNotInstalled) || !errors.Is(err, cause) ||
		!strings.Contains(err.Error(), "log text") {
		t.Fatalf("1603 must be a plain failure wrapping the cause with output, got %v", err)
	}
}
