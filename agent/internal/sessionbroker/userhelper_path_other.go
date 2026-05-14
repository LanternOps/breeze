//go:build !windows

package sessionbroker

import "os"

// userHelperExePath returns the running agent binary path on non-Windows
// platforms. macOS and Linux launch the user-helper as a subcommand of the
// agent binary (LaunchAgent / systemd user unit respectively), which does not
// have the Windows console-window problem.
func userHelperExePath() (string, error) {
	return os.Executable()
}
