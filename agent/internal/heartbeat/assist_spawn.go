package heartbeat

import (
	"fmt"
	"strconv"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// spawnProcessInSession is sessionbroker.SpawnProcessInSessionWithArgs; a var
// so tests can stand in for the Windows launch.
var spawnProcessInSession = sessionbroker.SpawnProcessInSessionWithArgs

// spawnAssistDirect launches Breeze Assist in the Windows session sessionKey
// as its signed-in user and returns Assist's own PID (#6923), which the
// helper manager's watcher tracks. It is the fallback when the user-role
// helper cannot launch Assist over IPC.
func spawnAssistDirect(sessionKey, binaryPath string, args []string) (int, error) {
	sessionNum, err := strconv.ParseUint(sessionKey, 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid session key %q: %w", sessionKey, err)
	}
	pid, err := spawnProcessInSession(binaryPath, args, uint32(sessionNum))
	if err != nil {
		return 0, err
	}
	return int(pid), nil
}
