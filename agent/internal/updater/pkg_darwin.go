//go:build darwin

package updater

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
)

// installViaPkg downloads the macOS .pkg installer for the given version and
// runs it via `installer -pkg`. The .pkg preserves the Apple Developer ID
// code signature and executes pre/post-install scripts (which handle
// LaunchDaemon/LaunchAgent setup and service restart).
func (u *Updater) installViaPkg(version string) error {
	// Download .pkg directly from GitHub releases
	pkgURL := fmt.Sprintf("https://github.com/LanternOps/breeze/releases/download/v%s/breeze-agent-darwin-%s.pkg",
		version, runtime.GOARCH)
	log.Info("downloading pkg for update", "url", pkgURL, "version", version)

	resp, err := u.client.Get(pkgURL)
	if err != nil {
		return fmt.Errorf("failed to download pkg: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("pkg download failed with status %d", resp.StatusCode)
	}

	// Write .pkg to temp file
	pkgFile, err := os.CreateTemp("", "breeze-agent-*.pkg")
	if err != nil {
		return fmt.Errorf("failed to create temp pkg file: %w", err)
	}
	pkgPath := pkgFile.Name()
	defer os.Remove(pkgPath)

	if _, err := io.Copy(pkgFile, resp.Body); err != nil {
		pkgFile.Close()
		return fmt.Errorf("failed to write pkg file: %w", err)
	}
	pkgFile.Close()

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
