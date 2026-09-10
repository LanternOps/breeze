package agentapp

import (
	"crypto/ed25519"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

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
		firstInstallReleaseBase(), version, goos, goarch, ext)
}

// isDevBuildVersion reports whether version names a locally built agent rather
// than a published release. Dev builds have no matching GitHub release, so any
// companion binary must be staged next to the agent by hand.
func isDevBuildVersion(version string) bool {
	return version == "" || version == "dev" || strings.HasPrefix(version, "dev-")
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
	releaseAssetMinSize    = 1 * 1024 * 1024 // 1 MB sanity check (real binary is several MB)
	releaseDownloadTimeout = 60 * time.Second
)

// bootstrapOptions is the inputs for bootstrapWatchdog. Kept as a struct so the
// callers on each OS stay short and the test helpers don't need long arg lists.
type bootstrapOptions struct {
	agentPath string // absolute path to the currently running agent binary
	version   string // agent version (main.version), e.g. "0.62.24" or "dev"
	goos      string // runtime.GOOS
	goarch    string // runtime.GOARCH

	// urlOverride, if non-empty, replaces the full download URL. Test-only.
	urlOverride string

	manifestURLOverride      string
	signatureURLOverride     string
	clientOverride           *http.Client
	trustKeysOverride        map[string]ed25519.PublicKey
	runInstaller             func(string) error
	protectedSiblingOverride func(string, string) bool
}

// bootstrapWatchdog resolves a watchdog binary (sibling first, GitHub download
// fallback) and then invokes `<watchdog> service install` to register it as a
// system service. All errors are returned — callers are expected to downgrade
// them to warnings so that a watchdog problem never aborts the agent install.
func bootstrapWatchdog(opts bootstrapOptions) error {
	siblingPath, siblingFound := locateSiblingWatchdog(opts.agentPath)
	if !siblingFound && isDevBuildVersion(opts.version) {
		return fmt.Errorf("no sibling watchdog found and agent is a dev build (version=%q); run `breeze-watchdog service install` manually", opts.version)
	}
	secureDir, err := os.MkdirTemp("", "breeze-watchdog-bootstrap-")
	if err != nil {
		return fmt.Errorf("create protected watchdog staging directory: %w", err)
	}
	defer func() { _ = os.RemoveAll(secureDir) }()
	watchdogPath := filepath.Join(secureDir, watchdogBinaryName(opts.goos))
	assetURL := opts.urlOverride
	if assetURL == "" {
		assetURL = watchdogDownloadURL(opts.version, opts.goos, opts.goarch)
	}
	spec := firstInstallArtifactSpec{
		component: "watchdog", version: opts.version, goos: opts.goos, goarch: opts.goarch,
		assetURL: assetURL, manifestURL: opts.manifestURLOverride,
		signatureURL: opts.signatureURLOverride, destPath: watchdogPath,
		client: opts.clientOverride, trustKeys: opts.trustKeysOverride,
	}
	protectedSibling := protectedPackagedSibling
	if opts.protectedSiblingOverride != nil {
		protectedSibling = opts.protectedSiblingOverride
	}
	staged := false
	if siblingFound {
		if protectedSibling(opts.agentPath, siblingPath) {
			if err := copyProtectedPackagedSibling(siblingPath, watchdogPath); err != nil {
				return fmt.Errorf("stage protected packaged watchdog: %w", err)
			}
			staged = true
		} else {
			spec.sourcePath = siblingPath
			spec.assetURL = ""
		}
	}
	if !staged {
		if err := stageFirstInstallArtifact(spec); err != nil {
			return fmt.Errorf("verify and stage watchdog: %w", err)
		}
	}

	runner := opts.runInstaller
	if runner == nil {
		runner = func(path string) error {
			cmd := exec.Command(path, "service", "install")
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			return cmd.Run()
		}
	}
	if err := runner(watchdogPath); err != nil {
		return fmt.Errorf("run %s service install: %w", watchdogPath, err)
	}
	return nil
}
