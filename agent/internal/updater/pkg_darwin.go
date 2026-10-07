//go:build darwin

package updater

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// installViaPkg downloads the macOS .pkg installer for the given version
// (from the control plane first, then the GitHub release — see
// pkgDownloadURLs), verifies it against the Ed25519-signed release manifest,
// and runs it via `installer -pkg`. The .pkg preserves the Apple Developer ID code signature
// and executes pre/post-install scripts (which handle LaunchDaemon/LaunchAgent
// setup and service restart).
//
// expectedSHA256 is the signed checksum extracted by pkgAssetChecksum from the
// same manifest that authenticated the agent binary. The .pkg bytes are
// verified against it BEFORE `installer` runs as root — without this check a
// TLS/DNS MITM toward the download host, a poisoned release asset, or a
// compromised CDN edge would yield arbitrary root code execution fleet-wide. The caller
// must never invoke this with an empty expectedSHA256.
func (u *Updater) installViaPkg(version, expectedSHA256 string) error {
	if expectedSHA256 == "" {
		return fmt.Errorf("refusing to install .pkg without a signed checksum")
	}
	// Download the .pkg from the control plane that issued the manifest, then
	// the release asset, and keep only bytes that match the signed checksum
	// (pkg_source.go). Verification happens BEFORE `installer` runs as root —
	// this is the trust binding that makes the download safe.
	pkgPath, err := u.fetchVerifiedPkg(pkgDownloadURLs(u.serverURL(), version, runtime.GOARCH), expectedSHA256)
	if err != nil {
		return fmt.Errorf("no pkg source matched the signed checksum: %w", err)
	}
	defer os.Remove(pkgPath)

	// Run the .pkg installer (requires root, which the agent service has)
	log.Info("installing pkg", "path", pkgPath)
	cmd := exec.Command("installer", "-pkg", pkgPath, "-target", "/")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("installer failed: %w (output: %s)", err, string(output))
	}

	log.Info("pkg install successful", "output", string(output))

	// The .pkg postinstall script handles service restart via launchctl kickstart.
	// Give it a moment, then exit — launchd will restart us with the new binary.
	return Restart()
}
