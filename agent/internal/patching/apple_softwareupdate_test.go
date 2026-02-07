//go:build darwin

package patching

import (
	"testing"
	"time"
)

func TestParseAppleInstallHistoryFiltersThirdPartyAndOldEntries(t *testing.T) {
	now := time.Date(2026, 2, 7, 12, 0, 0, 0, time.UTC)
	jsonPayload := []byte(`{
		"SPInstallHistoryDataType": [
			{
				"_name": "macOS Sequoia 15.3",
				"install_version": "15.3",
				"package_source": "package_source_apple",
				"install_date": "2026-02-01T10:00:00Z"
			},
			{
				"_name": "Google Chrome",
				"install_version": "133.0.1",
				"package_source": "package_source_homebrew",
				"install_date": "2026-02-01T10:00:00Z"
			},
			{
				"_name": "MobileAssets-XYZ",
				"install_version": "1",
				"package_source": "package_source_apple",
				"install_date": "2026-02-01T10:00:00Z"
			},
			{
				"_name": "Safari",
				"install_version": "18.0",
				"package_source": "package_source_apple",
				"install_date": "2025-01-01T00:00:00Z"
			}
		]
	}`)

	installed, err := parseAppleInstallHistory(jsonPayload, now, 90*24*time.Hour)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(installed) != 1 {
		t.Fatalf("expected 1 apple entry, got %d: %#v", len(installed), installed)
	}

	if installed[0].Title != "macOS Sequoia 15.3" {
		t.Fatalf("unexpected title %q", installed[0].Title)
	}
	if installed[0].Version != "15.3" {
		t.Fatalf("unexpected version %q", installed[0].Version)
	}
}

func TestIsApplePackageSource(t *testing.T) {
	if !isApplePackageSource("package_source_apple") {
		t.Fatal("expected apple source to be accepted")
	}
	if !isApplePackageSource("") {
		t.Fatal("expected empty source to default to apple")
	}
	if isApplePackageSource("package_source_homebrew") {
		t.Fatal("expected non-apple source to be rejected")
	}
}
