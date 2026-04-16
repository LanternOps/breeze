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

func TestBootstrapWatchdog_SiblingFound_RunsInstall(t *testing.T) {
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}
	siblingPath := filepath.Join(dir, watchdogBinaryName(runtime.GOOS))
	marker := filepath.Join(dir, "invoked")
	var script string
	if runtime.GOOS == "windows" {
		t.Skip("skipping exec-sibling test on Windows (need real .exe)")
	} else {
		script = "#!/bin/sh\necho invoked > \"" + marker + "\"\n"
	}
	if err := os.WriteFile(siblingPath, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}

	opts := bootstrapOptions{
		agentPath: agentPath,
		version:   "0.62.24",
		goos:      runtime.GOOS,
		goarch:    runtime.GOARCH,
	}
	if err := bootstrapWatchdog(opts); err != nil {
		t.Fatalf("bootstrapWatchdog: %v", err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Errorf("expected sibling watchdog to be invoked (marker %q not found): %v", marker, err)
	}
}

func TestBootstrapWatchdog_DevVersionSkipsDownload(t *testing.T) {
	cases := []string{"dev", "dev-abc123", ""}
	for _, v := range cases {
		t.Run(v, func(t *testing.T) {
			dir := t.TempDir()
			agentPath := filepath.Join(dir, "breeze-agent")
			if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
				t.Fatal(err)
			}
			opts := bootstrapOptions{
				agentPath: agentPath,
				version:   v,
				goos:      runtime.GOOS,
				goarch:    runtime.GOARCH,
			}
			if err := bootstrapWatchdog(opts); err == nil {
				t.Fatalf("bootstrapWatchdog(version=%q): expected error, got nil", v)
			}
		})
	}
}

func TestBootstrapWatchdog_DownloadFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}

	opts := bootstrapOptions{
		agentPath:   agentPath,
		version:     "0.62.24",
		goos:        runtime.GOOS,
		goarch:      runtime.GOARCH,
		urlOverride: srv.URL,
	}
	err := bootstrapWatchdog(opts)
	if err == nil {
		t.Fatalf("bootstrapWatchdog: expected error on download 404, got nil")
	}
}

func TestBootstrapWatchdog_SiblingExitsNonZero(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping exec-sibling test on Windows (need real .exe)")
	}
	dir := t.TempDir()
	agentPath := filepath.Join(dir, "breeze-agent")
	if err := os.WriteFile(agentPath, []byte("fake"), 0755); err != nil {
		t.Fatal(err)
	}
	siblingPath := filepath.Join(dir, watchdogBinaryName(runtime.GOOS))
	if err := os.WriteFile(siblingPath, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}

	opts := bootstrapOptions{
		agentPath: agentPath,
		version:   "0.62.24",
		goos:      runtime.GOOS,
		goarch:    runtime.GOARCH,
	}
	if err := bootstrapWatchdog(opts); err == nil {
		t.Fatalf("bootstrapWatchdog: expected error when sibling exits non-zero, got nil")
	}
}
