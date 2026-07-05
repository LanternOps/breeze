package tools

import (
	"fmt"
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
	attempts := buildWindowsUpdateAttempts("winget", "Mozilla Firefox", "", "Mozilla.Firefox")
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
	attempts := buildWindowsUpdateAttempts("winget", "Mozilla Firefox", "131.0", "Mozilla.Firefox")
	if !argsHave(attempts[0], "--id", "Mozilla.Firefox") || !argsHave(attempts[0], "--version", "131.0") {
		t.Fatalf("expected first attempt to be version-pinned --id, got %v", attempts[0].args)
	}
}

func TestBuildWindowsUpdateAttemptsUsesResolvedWingetCommand(t *testing.T) {
	t.Parallel()
	// Under the SYSTEM service "winget" isn't on PATH; the caller resolves the
	// versioned WindowsApps path and every attempt must invoke it verbatim.
	resolved := `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.22.10661.0_x64__8wekyb3d8bbwe\winget.exe`
	attempts := buildWindowsUpdateAttempts(resolved, "Mozilla Firefox", "131.0", "Mozilla.Firefox")
	if len(attempts) == 0 {
		t.Fatal("expected at least one attempt")
	}
	for _, a := range attempts {
		if a.command != resolved {
			t.Fatalf("expected all attempts to use resolved winget path, got %q", a.command)
		}
	}
}

func TestBuildWindowsUpdateAttemptsNameFirstWithoutPackageID(t *testing.T) {
	t.Parallel()
	attempts := buildWindowsUpdateAttempts("winget", "Mozilla Firefox", "", "")
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

// argsHaveFlag reports whether the attempt's args contain the given flag token
// anywhere (e.g. "--allow-downgrades", "downgrade").
func argsHaveFlag(a updateAttempt, flag string) bool {
	for _, arg := range a.args {
		if arg == flag {
			return true
		}
	}
	return false
}

// findAttempt returns the first attempt matching command + a required arg token,
// and whether it was found. Used to assert a specific verb (e.g. apt-get's
// downgrade attempt) exists in addition to the upgrade attempt.
func findAttempt(attempts []updateAttempt, command, requiredArg string) (updateAttempt, bool) {
	for _, a := range attempts {
		if a.command == command && argsHaveFlag(a, requiredArg) {
			return a, true
		}
	}
	return updateAttempt{}, false
}

func TestBuildLinuxUpdateAttemptsVersionPinIncludesDowngradePath(t *testing.T) {
	t.Parallel()
	// A pin can be OLDER than the installed build (an intentional downgrade/hold).
	// The plain upgrade/update verbs can't perform that, so each manager must also
	// offer a downgrade-capable attempt for the same pinned spec (#993).
	attempts := buildLinuxUpdateAttempts("firefox", "131.0")

	// apt-get: must have both --only-upgrade and --allow-downgrades for the pin.
	if _, ok := findAttempt(attempts, "apt-get", "--only-upgrade"); !ok {
		t.Fatalf("expected apt-get --only-upgrade pinned attempt, got %+v", attempts)
	}
	apt, ok := findAttempt(attempts, "apt-get", "--allow-downgrades")
	if !ok {
		t.Fatalf("expected apt-get --allow-downgrades pinned attempt, got %+v", attempts)
	}
	if !argsContain(apt, "firefox=131.0") {
		t.Fatalf("expected apt-get downgrade to target firefox=131.0, got %v", apt.args)
	}

	// dnf/yum: must have both the upgrade/update verb and a downgrade verb.
	for _, mgr := range []string{"dnf", "yum"} {
		dn, ok := findAttempt(attempts, mgr, "downgrade")
		if !ok {
			t.Fatalf("expected %s downgrade pinned attempt, got %+v", mgr, attempts)
		}
		if !argsContain(dn, "firefox-131.0") {
			t.Fatalf("expected %s downgrade to target firefox-131.0, got %v", mgr, dn.args)
		}
	}
	if _, ok := findAttempt(attempts, "dnf", "upgrade"); !ok {
		t.Fatalf("expected dnf upgrade pinned attempt, got %+v", attempts)
	}
	if _, ok := findAttempt(attempts, "yum", "update"); !ok {
		t.Fatalf("expected yum update pinned attempt, got %+v", attempts)
	}

	// zypper --oldpackage handles both directions in one shot.
	if _, ok := findAttempt(attempts, "zypper", "--oldpackage"); !ok {
		t.Fatalf("expected zypper --oldpackage pinned attempt, got %+v", attempts)
	}
}

func TestInstalledVersionMatchesPin(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name      string
		installed string
		pin       string
		want      bool
	}{
		{"exact match", "131.0", "131.0", true},
		{"apt epoch prefix", "1:131.0", "131.0", true},
		{"rpm release suffix", "131.0-1.fc39", "131.0", true},
		{"apt epoch and rpm release", "2:131.0-1.el9", "131.0", true},
		{"release-bearing pin exact", "131.0-1", "131.0-1", true},
		{"release-bearing pin with epoch", "1:131.0-1", "131.0-1", true},
		{"mismatch newer installed", "132.0", "131.0", false},
		{"mismatch older installed", "130.0", "131.0", false},
		{"release-bearing pin must not loosen", "131.0-2", "131.0-1", false},
		{"prefix is not a match", "131.0.1", "131.0", false},
		{"empty installed", "", "131.0", false},
		{"whitespace trimmed", " 131.0 ", "131.0", true},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := installedVersionMatchesPin(tc.installed, tc.pin); got != tc.want {
				t.Fatalf("installedVersionMatchesPin(%q, %q) = %v, want %v", tc.installed, tc.pin, got, tc.want)
			}
		})
	}
}

func TestVerifyLinuxPinnedVersion(t *testing.T) {
	t.Parallel()
	const pin = "131.0"

	cases := []struct {
		name        string
		query       linuxVersionQuery
		wantErr     bool
		errContains string
	}{
		{
			// pin == installed: the upgrade/update verb already had it; verify passes.
			name:    "pin equals installed",
			query:   func(string) (string, error) { return "131.0", nil },
			wantErr: false,
		},
		{
			// pin > installed (an upgrade): after a successful upgrade the installed
			// version is the pin; verify passes.
			name:    "pin newer than installed, now applied",
			query:   func(string) (string, error) { return "131.0", nil },
			wantErr: false,
		},
		{
			// pin < installed and the downgrade did NOT take (apt said "already the
			// newest version", runUpdateAttempts mapped it to success): the installed
			// version is still the newer build, so verify must FAIL loudly — this is
			// the silent-drop hole #993 is about, on Linux.
			name:        "pin older than installed, still newer installed",
			query:       func(string) (string, error) { return "132.0", nil },
			wantErr:     true,
			errContains: "version pin not honored",
		},
		{
			// pin < installed and the downgrade DID take: installed is now the pin.
			name:    "pin older than installed, downgrade applied",
			query:   func(string) (string, error) { return "131.0", nil },
			wantErr: false,
		},
		{
			// apt epoch decoration must not produce a false mismatch.
			name:    "installed reports apt epoch",
			query:   func(string) (string, error) { return "1:131.0", nil },
			wantErr: false,
		},
		{
			// rpm release decoration must not produce a false mismatch.
			name:    "installed reports rpm release",
			query:   func(string) (string, error) { return "131.0-1.fc39", nil },
			wantErr: false,
		},
		{
			// Can't determine the installed version → can't prove the pin held →
			// fail loudly rather than assume success.
			name:        "installed version unknown",
			query:       func(string) (string, error) { return "", nil },
			wantErr:     true,
			errContains: "could not determine",
		},
		{
			// Query tool error → fail loudly.
			name:        "query error",
			query:       func(string) (string, error) { return "", errTestQuery },
			wantErr:     true,
			errContains: "could not verify",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := verifyLinuxPinnedVersion("firefox", pin, tc.query)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected an error, got nil")
				}
				if tc.errContains != "" && !strings.Contains(err.Error(), tc.errContains) {
					t.Fatalf("expected error to contain %q, got %q", tc.errContains, err.Error())
				}
				return
			}
			if err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}

var errTestQuery = fmt.Errorf("dpkg-query exploded")

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
