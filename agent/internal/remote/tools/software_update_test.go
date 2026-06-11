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
