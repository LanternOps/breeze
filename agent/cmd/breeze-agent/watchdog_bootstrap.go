package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// NOTE: Keep this URL base in sync with agent/internal/updater/pkg_darwin.go.
// Both point at the same GitHub releases. If one ever moves to an env var,
// migrate both call sites together.
const watchdogReleasesBase = "https://github.com/LanternOps/breeze/releases/download"

// watchdogBinaryName returns the filename for the watchdog binary on the given GOOS.
func watchdogBinaryName(goos string) string {
	if goos == "windows" {
		return "breeze-watchdog.exe"
	}
	return "breeze-watchdog"
}

// watchdogDownloadURL returns the GitHub release download URL for the watchdog
// binary matching the given agent version / OS / arch.
func watchdogDownloadURL(version, goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("%s/v%s/breeze-watchdog-%s-%s%s",
		watchdogReleasesBase, version, goos, goarch, ext)
}

// locateSiblingWatchdog checks for the watchdog binary in the same directory
// as the agent binary. Returns (path, true) if found.
func locateSiblingWatchdog(agentPath string) (string, bool) {
	candidate := filepath.Join(filepath.Dir(agentPath), watchdogBinaryName(runtime.GOOS))
	info, err := os.Stat(candidate)
	if err != nil || info.IsDir() {
		return "", false
	}
	return candidate, true
}

const (
	watchdogMinSize       = 1 * 1024 * 1024 // 1 MB sanity check (real binary is several MB)
	watchdogDownloadTimeo = 60 * time.Second
)

// downloadWatchdog fetches the watchdog binary from url and writes it to destPath.
// The file is streamed to a sibling temp file and atomically renamed on success,
// so a partial download never leaves a broken binary behind. On unix the file is
// marked executable (0755).
func downloadWatchdog(url, destPath string) error {
	client := &http.Client{Timeout: watchdogDownloadTimeo}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("http get %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http get %s: status %d", url, resp.StatusCode)
	}

	tmpPath := destPath + ".download"
	tmp, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0755)
	if err != nil {
		return fmt.Errorf("create %s: %w", tmpPath, err)
	}
	n, copyErr := io.Copy(tmp, resp.Body)
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("download body: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("close %s: %w", tmpPath, closeErr)
	}
	if n < watchdogMinSize {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("downloaded body too small (%d bytes); URL likely returned an error page", n)
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("rename %s -> %s: %w", tmpPath, destPath, err)
	}
	return nil
}
