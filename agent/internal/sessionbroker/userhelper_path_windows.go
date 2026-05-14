//go:build windows

package sessionbroker

import (
	"fmt"
	"os"
)

// userHelperExePath returns the path that the SYSTEM-context spawner should
// use when launching a user-helper process. On Windows the convention is:
//
//   - C:\Program Files\Breeze\breeze-agent.exe   (this process, console subsystem)
//   - C:\Program Files\Breeze\breeze-user-helper.exe (GUI subsystem, same source)
//
// Resolution logic lives in resolveUserHelperPath (userhelper_path.go) so the
// fallback semantics are unit-testable on every platform the agent builds on,
// not just Windows. This wrapper just supplies the agent's own executable
// path and delegates.
func userHelperExePath() (string, error) {
	agentExe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("os.Executable: %w", err)
	}
	return resolveUserHelperPath(agentExe)
}
