package onedrivehelper

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// oneDriveKillWait bounds how long a OneDrive restart waits for taskkill to
// finish before relaunching. taskkill normally exits within a second; the
// bound only matters if it hangs, and restartOneDrive runs on the heartbeat,
// once per signed-in session.
const oneDriveKillWait = 5 * time.Second

// taskkillNoMatch is taskkill's exit code when no process matched the image
// name: OneDrive was not running, so there was nothing to kill.
const taskkillNoMatch = 128

// runInSession and spawnInSession launch a process as a session's signed-in
// user; vars so tests can record the launches.
var (
	runInSession   = sessionbroker.RunProcessInSessionWithArgs
	spawnInSession = sessionbroker.SpawnProcessInSessionWithArgs
)

// restartOneDriveInSession kills OneDrive in sessionID and relaunches
// oneDriveExe there. The relaunch waits for taskkill to exit (#6923): fired
// together, taskkill can also kill the new instance and leave the user with
// no OneDrive. The relaunch happens whatever taskkill did, so a failed or slow
// kill never stops OneDrive coming back. killErr reports a kill that could not
// be launched, did not finish within oneDriveKillWait, or exited with a
// failure; relaunchErr a relaunch that could not be launched.
func restartOneDriveInSession(taskkillExe, oneDriveExe string, sessionID uint32) (killErr, relaunchErr error) {
	code, err := runInSession(taskkillExe, []string{"/f", "/im", "OneDrive.exe"}, sessionID, oneDriveKillWait)
	switch {
	case err != nil:
		killErr = err
	case code != 0 && code != taskkillNoMatch:
		killErr = fmt.Errorf("taskkill exited with code %d", code)
	}
	_, relaunchErr = spawnInSession(oneDriveExe, []string{"/background"}, sessionID)
	return killErr, relaunchErr
}
