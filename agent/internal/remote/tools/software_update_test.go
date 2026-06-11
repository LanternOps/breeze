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
