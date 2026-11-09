package onedrivehelper

import (
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// oneDriveKillWait bounds how long a OneDrive restart waits for taskkill to
// finish before relaunching. taskkill normally exits within a second; the
// bound only matters if it hangs, and restartOneDrive runs on the heartbeat.
const oneDriveKillWait = 10 * time.Second

// runInSession and spawnInSession launch a process as a session's signed-in
// user; vars so tests can record the launches.
var (
	runInSession   = sessionbroker.RunProcessInSessionWithArgs
	spawnInSession = sessionbroker.SpawnProcessInSessionWithArgs
)

// restartOneDriveInSession kills OneDrive in sessionID and relaunches
// oneDriveExe there. The relaunch waits for taskkill to exit (#6923): fired
// together, taskkill can also kill the new instance and leave the user with
// no OneDrive. The relaunch happens whatever taskkill returned, so a failed or
// slow kill never stops OneDrive coming back.
func restartOneDriveInSession(taskkillExe, oneDriveExe string, sessionID uint32) (killErr, relaunchErr error) {
	_, killErr = runInSession(taskkillExe, []string{"/f", "/im", "OneDrive.exe"}, sessionID, oneDriveKillWait)
	_, relaunchErr = spawnInSession(oneDriveExe, []string{"/background"}, sessionID)
	return killErr, relaunchErr
}
