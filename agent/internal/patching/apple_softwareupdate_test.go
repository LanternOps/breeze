//go:build darwin

package patching

import (
	"strings"
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

func TestParseSoftwareUpdateListPreservesLabelAsKBNumber(t *testing.T) {
	output := []byte(`Software Update Tool

Finding available software
Software Update found the following new or updated software:
* Label: Safari18.3-18.3
	Title: Safari, Version: 18.3, Size: 123456K, Recommended: YES,
* Label: macOS Sequoia 15.3.2-15.3.2
	Title: macOS Sequoia 15.3.2, Version: 15.3.2, Size: 7654321K, Recommended: YES, Action: restart,
`)

	patches := parseSoftwareUpdateList(output)
	if len(patches) != 2 {
		t.Fatalf("expected 2 patches, got %d", len(patches))
	}

	// Safari patch
	if patches[0].ID != "Safari18.3-18.3" {
		t.Errorf("expected ID Safari18.3-18.3, got %q", patches[0].ID)
	}
	if patches[0].Title != "Safari" {
		t.Errorf("expected Title Safari, got %q", patches[0].Title)
	}
	if patches[0].KBNumber != "Safari18.3-18.3" {
		t.Errorf("expected KBNumber (label) Safari18.3-18.3, got %q", patches[0].KBNumber)
	}
	if patches[0].Version != "18.3" {
		t.Errorf("expected Version 18.3, got %q", patches[0].Version)
	}

	// macOS patch
	if patches[1].KBNumber != "macOS Sequoia 15.3.2-15.3.2" {
		t.Errorf("expected KBNumber (label) for macOS, got %q", patches[1].KBNumber)
	}
	if patches[1].Description != "restart required" {
		t.Errorf("expected restart required description, got %q", patches[1].Description)
	}
}

func TestLooksLikeSoftwareUpdateLabel(t *testing.T) {
	tests := []struct {
		id   string
		want bool
	}{
		{"Safari18.3-18.3", true},
		{"macOS Sequoia 15.3.2-15.3.2", true},
		{"Command Line Tools for Xcode-16.2", true},
		{"Safari", false},
		{"macOS Sequoia", false},
		{"", false},
		{"no-dash-with-alpha-after", false},
	}
	for _, tt := range tests {
		if got := looksLikeSoftwareUpdateLabel(tt.id); got != tt.want {
			t.Errorf("looksLikeSoftwareUpdateLabel(%q) = %v, want %v", tt.id, got, tt.want)
		}
	}
}

func TestIsNoOpSoftwareUpdateOutput(t *testing.T) {
	tests := []struct {
		output string
		want   bool
	}{
		{"No new software available.", true},
		{"no updates are available", true},
		{"no updates found", true},
		{"", true},
		{"   ", true},
		{"Software Update Tool\n\nFinding available software\nNo new software available.", true},
		{"Downloading Safari 18.3\nInstalling Safari 18.3\nDone with Safari 18.3\nDone.", false},
		{"downloading safari\ninstalling safari\ndone.", false},
		{"Software Update Tool\n\nFinding available software\nDownloaded macOS Sequoia 15.3.2\nPreparing to install...\nInstalling macOS Sequoia 15.3.2\nDone.", false},
		{"Installed 1 update.", false},
	}
	for _, tt := range tests {
		lower := strings.ToLower(tt.output)
		if got := isNoOpSoftwareUpdateOutput(lower); got != tt.want {
			t.Errorf("isNoOpSoftwareUpdateOutput(%q) = %v, want %v", tt.output, got, tt.want)
		}
	}
}
