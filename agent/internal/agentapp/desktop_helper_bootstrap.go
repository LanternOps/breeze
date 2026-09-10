package agentapp

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
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
		firstInstallReleaseBase(), version, desktopHelperBinaryName, goos, goarch, ext)
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

	manifestURLOverride      string
	signatureURLOverride     string
	clientOverride           *http.Client
	trustKeysOverride        map[string]ed25519.PublicKey
	protectedSiblingOverride func(string, string) bool
}

// stageDesktopHelper installs the real desktop-helper binary at opts.destPath:
// the copy staged next to the agent (what the .pkg and every build lane ship)
// if present, otherwise the matching-version asset authorized by the signed
// release manifest.
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
	info, readErr := os.Stat(sibling)
	switch {
	case readErr == nil:
		if !info.Mode().IsRegular() {
			return fmt.Errorf("read desktop helper at %s: not a regular file", sibling)
		}
	case !errors.Is(readErr, fs.ErrNotExist):
		// Present but unreadable (permissions, a directory, I/O error). Report
		// it rather than reaching for the network and masking a local problem.
		return fmt.Errorf("read desktop helper at %s: %w", sibling, readErr)
	}

	if readErr != nil && isDevBuildVersion(opts.version) {
		return fmt.Errorf("no desktop helper found at %s and the agent is a dev build (version=%q); build it with `make build` and place it next to the agent binary", sibling, opts.version)
	}

	assetURL := opts.urlOverride
	if assetURL == "" {
		assetURL = desktopHelperDownloadURL(opts.version, opts.goos, opts.goarch)
	}
	spec := firstInstallArtifactSpec{
		component: "desktop-helper", version: opts.version, goos: opts.goos, goarch: opts.goarch,
		assetURL: assetURL, manifestURL: opts.manifestURLOverride,
		signatureURL: opts.signatureURLOverride, destPath: opts.destPath,
		client: opts.clientOverride, trustKeys: opts.trustKeysOverride,
	}
	if readErr == nil {
		protectedSibling := protectedPackagedSibling
		if opts.protectedSiblingOverride != nil {
			protectedSibling = opts.protectedSiblingOverride
		}
		if protectedSibling(opts.agentPath, sibling) {
			if filepath.Clean(sibling) == filepath.Clean(opts.destPath) {
				return nil
			}
			return copyProtectedPackagedSibling(sibling, opts.destPath)
		}
		spec.sourcePath = sibling
		spec.assetURL = ""
	}
	if err := stageFirstInstallArtifact(spec); err != nil {
		return fmt.Errorf("verify and stage desktop helper: %w", err)
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
// executable at path. Signed first-install staging uses the same primitive.
func writeBinaryAtomically(path string, data []byte) error {
	tmp, err := secureTempFor(path)
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
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
