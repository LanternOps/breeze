package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestWatchdogBinaryName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "breeze-watchdog.exe"},
		{"linux", "breeze-watchdog"},
		{"darwin", "breeze-watchdog"},
	}
	for _, tc := range tests {
		got := watchdogBinaryName(tc.goos)
		if got != tc.want {
			t.Errorf("watchdogBinaryName(%q) = %q, want %q", tc.goos, got, tc.want)
		}
	}
}

func TestWatchdogDownloadURL(t *testing.T) {
	tests := []struct {
		version, goos, goarch, want string
	}{
		{
			"0.62.24", "windows", "amd64",
			"https://github.com/LanternOps/breeze/releases/download/v0.62.24/breeze-watchdog-windows-amd64.exe",
		},
		{
			"0.62.24", "linux", "arm64",
			"https://github.com/LanternOps/breeze/releases/download/v0.62.24/breeze-watchdog-linux-arm64",
		},
		{
			"0.62.24", "darwin", "amd64",
			"https://github.com/LanternOps/breeze/releases/download/v0.62.24/breeze-watchdog-darwin-amd64",
		},
	}
	for _, tc := range tests {
		got := watchdogDownloadURL(tc.version, tc.goos, tc.goarch)
		if got != tc.want {
			t.Errorf("watchdogDownloadURL(%q,%q,%q) = %q, want %q",
				tc.version, tc.goos, tc.goarch, got, tc.want)
		}
	}
}

func TestLocateSiblingWatchdog_Found(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if runtime.GOOS == "windows" {
		agentPath += ".exe"
	}
	if err := os.WriteFile(agentPath, []byte("fake agent"), 0755); err != nil {
		t.Fatal(err)
	}
	siblingPath := filepath.Join(dir, watchdogBinaryName(runtime.GOOS))
	if err := os.WriteFile(siblingPath, []byte("fake watchdog"), 0755); err != nil {
		t.Fatal(err)
	}

	got, ok := locateSiblingWatchdog(agentPath)
	if !ok {
		t.Fatalf("locateSiblingWatchdog returned ok=false, want true")
	}
	if got != siblingPath {
		t.Errorf("locateSiblingWatchdog = %q, want %q", got, siblingPath)
	}
}

func TestLocateSiblingWatchdog_NotFound(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake agent"), 0755); err != nil {
		t.Fatal(err)
	}

	_, ok := locateSiblingWatchdog(agentPath)
	if ok {
		t.Errorf("locateSiblingWatchdog returned ok=true, want false")
	}
}
