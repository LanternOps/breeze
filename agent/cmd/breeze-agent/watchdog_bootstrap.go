package main

import "fmt"

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
