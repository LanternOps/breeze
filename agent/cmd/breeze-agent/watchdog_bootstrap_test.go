package main

import (
	"net/http"
	"net/http/httptest"
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

func TestDownloadWatchdog_Success(t *testing.T) {
	body := make([]byte, 2*1024*1024)
	for i := range body {
		body[i] = byte(i % 256)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	destDir := t.TempDir()
	destPath := filepath.Join(destDir, "breeze-watchdog")

	if err := downloadWatchdog(srv.URL, destPath); err != nil {
		t.Fatalf("downloadWatchdog: %v", err)
	}

	got, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("read downloaded file: %v", err)
	}
	if len(got) != len(body) {
		t.Errorf("downloaded size = %d, want %d", len(got), len(body))
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(destPath)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if info.Mode().Perm()&0100 == 0 {
			t.Errorf("downloaded file is not executable: mode=%v", info.Mode())
		}
	}
}

func TestDownloadWatchdog_404(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	destPath := filepath.Join(t.TempDir(), "breeze-watchdog")
	err := downloadWatchdog(srv.URL, destPath)
	if err == nil {
		t.Fatalf("downloadWatchdog: expected error on 404, got nil")
	}
	if _, statErr := os.Stat(destPath); statErr == nil {
		t.Errorf("downloadWatchdog: dest file should not exist after failure")
	}
}

func TestDownloadWatchdog_TooSmall(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("not a real binary"))
	}))
	defer srv.Close()

	destPath := filepath.Join(t.TempDir(), "breeze-watchdog")
	err := downloadWatchdog(srv.URL, destPath)
	if err == nil {
		t.Fatalf("downloadWatchdog: expected error on too-small body, got nil")
	}
	if _, statErr := os.Stat(destPath); statErr == nil {
		t.Errorf("downloadWatchdog: dest file should not exist after failure")
	}
}
