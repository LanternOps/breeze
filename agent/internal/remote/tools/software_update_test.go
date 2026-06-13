package tools

import (
	"runtime"
	"strings"
	"testing"
)

// UpdateSoftware shares the same name/version validators as UninstallSoftware,
// so we lean on the existing validator tests and only assert the public entry
// point's error mapping here.

func TestUpdateSoftwareRejectsBlankName(t *testing.T) {
	t.Parallel()
	result := UpdateSoftware(map[string]any{"name": "", "version": ""})
	if result.Status != "failed" {
		t.Fatalf("expected failed status for blank name, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "software name is required") {
		t.Fatalf("expected validation error, got %q", result.Error)
	}
}

func TestUpdateSoftwareRejectsShellMetaInName(t *testing.T) {
	t.Parallel()
	result := UpdateSoftware(map[string]any{"name": "Chrome;rm -rf /"})
	if result.Status != "failed" {
		t.Fatalf("expected failed status for shell meta, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "unsafe characters") {
		t.Fatalf("expected unsafe-chars validation error, got %q", result.Error)
	}
}

func TestUpdateSoftwareRejectsLeadingDashName(t *testing.T) {
	t.Parallel()
	result := UpdateSoftware(map[string]any{"name": "-rf"})
	if result.Status != "failed" {
		t.Fatalf("expected failed status for leading dash, got %s", result.Status)
	}
}

func TestUpdateSoftwareLinuxProtectedPackage(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "linux" {
		t.Skipf("linux-only guard test, current %s", runtime.GOOS)
	}
	result := UpdateSoftware(map[string]any{"name": "systemd"})
	if result.Status != "failed" {
		t.Fatalf("expected refusal for protected package, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "protected package") {
		t.Fatalf("expected protected-package error, got %q", result.Error)
	}
}

func TestUpdateSoftwareUnsupportedVersionFormat(t *testing.T) {
	t.Parallel()
	result := UpdateSoftware(map[string]any{"name": "Chrome", "version": "1.0;rm"})
	if result.Status != "failed" {
		t.Fatalf("expected failed status for unsafe version, got %s", result.Status)
	}
}

func TestUpdateSoftwareRejectsUnsafePackageID(t *testing.T) {
	t.Parallel()
	result := UpdateSoftware(map[string]any{"name": "Firefox", "packageId": "Mozilla.Firefox;rm -rf /"})
	if result.Status != "failed" {
		t.Fatalf("expected failed status for unsafe packageId, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "packageId contains unsafe characters") {
		t.Fatalf("expected packageId validation error, got %q", result.Error)
	}
}

// argsHave reports whether the attempt's args contain the given flag immediately
// followed by the given value (e.g. "--id" then "Mozilla.Firefox").
func argsHave(a updateAttempt, flag, value string) bool {
	for i := 0; i+1 < len(a.args); i++ {
		if a.args[i] == flag && a.args[i+1] == value {
			return true
		}
	}
	return false
}

func TestBuildWindowsUpdateAttemptsPrefersPackageID(t *testing.T) {
	t.Parallel()
	attempts := buildWindowsUpdateAttempts("Mozilla Firefox", "", "Mozilla.Firefox")
	if len(attempts) == 0 {
		t.Fatal("expected at least one attempt")
	}
	// The --id <packageID> attempt must come first, ahead of any --name attempt.
	if !argsHave(attempts[0], "--id", "Mozilla.Firefox") {
		t.Fatalf("expected first attempt to select --id Mozilla.Firefox, got %v", attempts[0].args)
	}
	firstName, firstID := -1, -1
	for i, a := range attempts {
		if firstName == -1 && argsHave(a, "--name", "Mozilla Firefox") {
			firstName = i
		}
		if firstID == -1 && argsHave(a, "--id", "Mozilla.Firefox") {
			firstID = i
		}
	}
	if firstID == -1 || firstName == -1 || firstID >= firstName {
		t.Fatalf("expected --id packageID before --name; firstID=%d firstName=%d", firstID, firstName)
	}
}

func TestBuildWindowsUpdateAttemptsVersionPinnedIDFirst(t *testing.T) {
	t.Parallel()
	attempts := buildWindowsUpdateAttempts("Mozilla Firefox", "131.0", "Mozilla.Firefox")
	if !argsHave(attempts[0], "--id", "Mozilla.Firefox") || !argsHave(attempts[0], "--version", "131.0") {
		t.Fatalf("expected first attempt to be version-pinned --id, got %v", attempts[0].args)
	}
}

func TestBuildWindowsUpdateAttemptsNameFirstWithoutPackageID(t *testing.T) {
	t.Parallel()
	attempts := buildWindowsUpdateAttempts("Mozilla Firefox", "", "")
	// Without a packageID, behavior is unchanged: --name is tried first.
	if !argsHave(attempts[0], "--name", "Mozilla Firefox") {
		t.Fatalf("expected first attempt to select --name when no packageID, got %v", attempts[0].args)
	}
	for _, a := range attempts {
		if argsHave(a, "--id", "Mozilla.Firefox") {
			t.Fatal("did not expect a packageID attempt when none was supplied")
		}
	}
}

// argsContain reports whether the attempt's args contain the given value
// anywhere (used for whole-token package specs like "pkg=1.2.3").
func argsContain(a updateAttempt, value string) bool {
	for _, arg := range a.args {
		if arg == value {
			return true
		}
	}
	return false
}

// hasCommand reports whether any attempt uses the given package-manager binary.
func hasCommand(attempts []updateAttempt, command string) bool {
	for _, a := range attempts {
		if a.command == command {
			return true
		}
	}
	return false
}

// findCommand returns the first attempt using the given binary (and whether it
// was found).
func findCommand(attempts []updateAttempt, command string) (updateAttempt, bool) {
	for _, a := range attempts {
		if a.command == command {
			return a, true
		}
	}
	return updateAttempt{}, false
}

func TestBuildLinuxUpdateAttemptsNoVersionUpgradesToLatest(t *testing.T) {
	t.Parallel()
	attempts := buildLinuxUpdateAttempts("firefox", "")

	// Without a pin every supported manager — including pacman — is attempted,
	// each targeting the bare package name (latest available).
	for _, mgr := range []string{"apt-get", "dnf", "yum", "zypper", "pacman"} {
		a, ok := findCommand(attempts, mgr)
		if !ok {
			t.Fatalf("expected an attempt for %s, got %+v", mgr, attempts)
		}
		if !argsContain(a, "firefox") {
			t.Fatalf("expected %s attempt to target bare name 'firefox', got %v", mgr, a.args)
		}
		// No version-pinned spec should leak in.
		for _, arg := range a.args {
			if strings.Contains(arg, "firefox=") || strings.Contains(arg, "firefox-") {
				t.Fatalf("unexpected version-pinned spec for %s: %v", mgr, a.args)
			}
		}
	}
}

func TestBuildLinuxUpdateAttemptsVersionPinUsesExactSelector(t *testing.T) {
	t.Parallel()
	attempts := buildLinuxUpdateAttempts("firefox", "131.0")

	cases := []struct {
		command string
		spec    string
	}{
		{"apt-get", "firefox=131.0"},
		{"dnf", "firefox-131.0"},
		{"yum", "firefox-131.0"},
		{"zypper", "firefox=131.0"},
	}
	for _, tc := range cases {
		a, ok := findCommand(attempts, tc.command)
		if !ok {
			t.Fatalf("expected a %s attempt for a version pin, got %+v", tc.command, attempts)
		}
		if !argsContain(a, tc.spec) {
			t.Fatalf("expected %s to pin via %q, got %v", tc.command, tc.spec, a.args)
		}
	}

	// zypper needs --oldpackage so the pin can downgrade past a newer installed
	// version; otherwise the pin would be a no-op when a newer build is present.
	if z, ok := findCommand(attempts, "zypper"); ok {
		if !argsContain(z, "--oldpackage") {
			t.Fatalf("expected zypper pin to include --oldpackage, got %v", z.args)
		}
	}
}

func TestBuildLinuxUpdateAttemptsVersionPinExcludesPacman(t *testing.T) {
	t.Parallel()
	// pacman cannot install an arbitrary repo version, so it must NOT appear in a
	// pinned upgrade — otherwise it would silently jump to whatever the synced
	// repos currently hold, defeating the pin (#993).
	attempts := buildLinuxUpdateAttempts("firefox", "131.0")
	if hasCommand(attempts, "pacman") {
		t.Fatalf("did not expect pacman in a version-pinned upgrade, got %+v", attempts)
	}
}

func TestUpdateSoftwareMacOSRejectsVersionPin(t *testing.T) {
	t.Parallel()
	// macOS cannot honor a pin (Homebrew always upgrades to latest), so it must
	// fail loudly rather than silently upgrading past the pin (#993). The guard
	// lives in updateSoftwareMacOS, so exercise it directly to stay
	// platform-independent.
	err := updateSoftwareMacOS("Firefox", "131.0")
	if err == nil {
		t.Fatal("expected an error when pinning a version on macOS, got nil")
	}
	if !strings.Contains(err.Error(), "version pinning is not supported") {
		t.Fatalf("expected unsupported-pin error, got %q", err.Error())
	}
}

func TestUpdateSoftwareMacOSAllowsLatestUpgrade(t *testing.T) {
	t.Parallel()
	// Without a pin, macOS must NOT hit the unsupported-version guard — it should
	// fall through to building brew attempts. We can't run brew here, so on
	// non-darwin we only assert the guard didn't reject; on darwin the call may
	// fail later for lack of brew, which is fine as long as it isn't our pin
	// error.
	err := updateSoftwareMacOS("Firefox", "")
	if err != nil && strings.Contains(err.Error(), "version pinning is not supported") {
		t.Fatalf("did not expect the pin guard to fire without a version, got %q", err.Error())
	}
}

// TestUpdateSoftwareMacOSPinSurfacedThroughPublicEntry confirms the rejection
// reaches the public CommandResult on darwin (where updateSoftwareOS routes to
// macOS). On other platforms updateSoftwareOS routes elsewhere, so skip.
func TestUpdateSoftwareMacOSPinSurfacedThroughPublicEntry(t *testing.T) {
	t.Parallel()
	if runtime.GOOS != "darwin" {
		t.Skipf("darwin-only routing test, current %s", runtime.GOOS)
	}
	result := UpdateSoftware(map[string]any{"name": "Firefox", "version": "131.0"})
	if result.Status != "failed" {
		t.Fatalf("expected failed status for macOS version pin, got %s", result.Status)
	}
	if !strings.Contains(result.Error, "version pinning is not supported") {
		t.Fatalf("expected unsupported-pin error, got %q", result.Error)
	}
}

func TestValidateSoftwarePackageID(t *testing.T) {
	t.Parallel()
	// Empty is allowed (the field is optional).
	if err := validateSoftwarePackageID(""); err != nil {
		t.Fatalf("expected empty packageId to be allowed, got %v", err)
	}
	// Canonical winget identifiers pass.
	for _, ok := range []string{"Mozilla.Firefox", "Google.Chrome", "7zip.7zip", "Microsoft.VisualStudioCode"} {
		if err := validateSoftwarePackageID(ok); err != nil {
			t.Fatalf("expected %q to be valid, got %v", ok, err)
		}
	}
	// Shell metacharacters / spaces / leading dash are rejected.
	for _, bad := range []string{"Mozilla Firefox", "Foo;bar", "-rf", "a/b", "x$y"} {
		if err := validateSoftwarePackageID(bad); err == nil {
			t.Fatalf("expected %q to be rejected", bad)
		}
	}
}
