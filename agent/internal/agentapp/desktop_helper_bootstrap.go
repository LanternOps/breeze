package agentapp

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// desktopHelperBinaryName is the on-disk name of the per-user desktop helper.
// The agent dispatches into the helper implementation when argv[0] has this
// basename (see main.go), which is exactly why the agent binary must never be
// installed under this name — see stageDesktopHelper.
const desktopHelperBinaryName = "breeze-desktop-helper"

// desktopHelperDownloadURL returns the GitHub release download URL for the
// desktop helper matching the given agent version / OS / arch. The release
// workflow publishes and notarizes this asset alongside the agent and the
// watchdog, and lists it in the release's checksums.txt.
func desktopHelperDownloadURL(version, goos, goarch string) string {
	ext := ""
	if goos == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("%s/v%s/%s-%s-%s%s",
		releasesBase, version, desktopHelperBinaryName, goos, goarch, ext)
}

// desktopHelperStageOptions is the input for stageDesktopHelper. Kept as a
// struct so the OS callers stay short and tests don't need long arg lists.
type desktopHelperStageOptions struct {
	agentPath string // absolute path to the currently running agent binary
	destPath  string // where the helper must end up, e.g. /usr/local/bin/breeze-desktop-helper
	version   string // agent version (main.version), e.g. "0.109.0" or "dev"
	goos      string // runtime.GOOS
	goarch    string // runtime.GOARCH

	// urlOverride, if non-empty, replaces the full download URL. Test-only.
	urlOverride string

	// checksumOverride, if non-empty, replaces the checksums.txt lookup. Test-only.
	checksumOverride string
}

// stageDesktopHelper installs the real desktop-helper binary at opts.destPath:
// the copy staged next to the agent (what the .pkg and every build lane ship)
// if present, otherwise the matching-version, checksum-verified asset from the
// GitHub release.
//
// It must NEVER fall back to installing the agent binary under the helper's
// name, which is what it used to do (#3457). The agent is a multi-call binary,
// so argv[0] dispatch made that substitute *work* — but the installed "helper"
// then carried the AGENT's code-signing identifier and designated requirement.
// macOS keys TCC grants (Screen Recording, Accessibility) to that identity, so
// the moment a real helper arrived — a .pkg install, an update — the identity
// flipped, the grants stopped matching, and every user was re-prompted. A
// missing helper is a visible, fixable install gap; a silently mis-identified
// one is a permission bug that surfaces days later on an unrelated upgrade.
//
// All errors are returned. Callers are expected to downgrade them to a warning
// so a helper problem never aborts the agent install, matching bootstrapWatchdog.
func stageDesktopHelper(opts desktopHelperStageOptions) error {
	sibling := filepath.Join(filepath.Dir(opts.agentPath), desktopHelperBinaryName)
	data, readErr := os.ReadFile(sibling)
	switch {
	case readErr == nil:
		if err := writeBinaryAtomically(opts.destPath, data); err != nil {
			return fmt.Errorf("copy desktop helper to %s: %w", opts.destPath, err)
		}
		return nil
	case !errors.Is(readErr, fs.ErrNotExist):
		// Present but unreadable (permissions, a directory, I/O error). Report
		// it rather than reaching for the network and masking a local problem.
		return fmt.Errorf("read desktop helper at %s: %w", sibling, readErr)
	}

	if isDevBuildVersion(opts.version) {
		return fmt.Errorf("no desktop helper found at %s and the agent is a dev build (version=%q); build it with `make build` and place it next to the agent binary", sibling, opts.version)
	}

	url := opts.urlOverride
	if url == "" {
		url = desktopHelperDownloadURL(opts.version, opts.goos, opts.goarch)
	}
	checksum := opts.checksumOverride
	if checksum == "" {
		if opts.urlOverride != "" {
			return fmt.Errorf("desktop helper checksum required when urlOverride is set")
		}
		var err error
		checksum, err = fetchReleaseAssetChecksum(releaseChecksumsURL(opts.version), filepath.Base(url))
		if err != nil {
			return fmt.Errorf("fetch desktop helper checksum: %w", err)
		}
	}

	fmt.Fprintf(os.Stderr, "Downloading desktop helper from %s ...\n", url)
	if err := downloadReleaseAsset(url, opts.destPath, checksum); err != nil {
		return fmt.Errorf("download desktop helper: %w", err)
	}
	return nil
}

// desktopHelperUnavailableWarning is the operator-facing message for a failed
// stageDesktopHelper. It says what is degraded, why the agent binary is not
// substituted, and how to fix it — the install itself continues.
func desktopHelperUnavailableWarning(err error, version, goos, goarch string) string {
	return fmt.Sprintf(
		"Warning: desktop helper not installed: %v\n"+
			"The agent service is installed and will run. Features that need the\n"+
			"per-user desktop helper (screen sharing, the logged-in-user session)\n"+
			"stay unavailable until the helper is present.\n"+
			"Breeze does NOT substitute the agent binary for the helper: that would\n"+
			"install it under the agent's code-signing identity, and macOS drops the\n"+
			"Screen Recording / Accessibility grants once the real helper replaces it.\n"+
			"To fix, choose one of:\n"+
			"  1. Install with the macOS .pkg, which ships the signed helper.\n"+
			"  2. Download %s, place it next to breeze-agent,\n"+
			"     then re-run `sudo breeze-agent service install`.\n",
		err, desktopHelperDownloadURL(version, goos, goarch))
}

// writeBinaryAtomically writes data to path via a sibling temp file and an
// atomic rename, so a failure part-way through can never leave a truncated
// executable at path. downloadReleaseAsset does the same for the network path;
// the sibling copy must not be the weaker of the two.
func writeBinaryAtomically(path string, data []byte) error {
	// Per-process temp name: two concurrent `service install` runs must not
	// share a staging file, where one's cleanup would delete the other's
	// in-flight write.
	tmpPath := fmt.Sprintf("%s.staging.%d", path, os.Getpid())
	if err := os.WriteFile(tmpPath, data, 0o755); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// desktopHelperInstalled reports whether a usable helper binary sits at path.
func desktopHelperInstalled(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Size() > 0
}

// desktopHelperLaunchAgentsWanted reports whether install-service should write
// and bootstrap the helper's LaunchAgent plists.
//
// The plists name /usr/local/bin/breeze-desktop-helper as their Program. Handing
// launchd a job whose program does not exist makes it retry a doomed
// posix_spawn on its KeepAlive schedule indefinitely, and that failure is
// invisible from the agent — it shows up only in launchctl/Console on the box.
// Before #3457 this could not happen, because install-service always left
// *something* at that path: the agent binary itself. Now that the substitution
// is gone, the plists have to be gated.
//
// A staging failure on a host that still has a helper from an earlier install is
// NOT a reason to skip them — that binary may be a pre-#3457 substituted agent
// binary, but it works, and tearing down its LaunchAgents would turn a
// wrong-identity helper into no helper at all. It is corrected on the next
// install that can reach a real helper.
func desktopHelperLaunchAgentsWanted(stageErr error, helperPath string) bool {
	if stageErr == nil {
		return true
	}
	return desktopHelperInstalled(helperPath)
}
