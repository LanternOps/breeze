package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
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
