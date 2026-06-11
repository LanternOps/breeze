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
