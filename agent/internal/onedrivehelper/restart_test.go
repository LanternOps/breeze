package onedrivehelper

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"
)

type launchCall struct {
	kind    string // "run" or "spawn"
	binary  string
	args    []string
	session uint32
	timeout time.Duration
}

// stubSessionLaunchers records launches; taskkill "exits" with killCode or
// fails to launch with killErr.
func stubSessionLaunchers(t *testing.T, killCode uint32, killErr error) *[]launchCall {
	t.Helper()
	origRun, origSpawn := runInSession, spawnInSession
	t.Cleanup(func() { runInSession, spawnInSession = origRun, origSpawn })
	var calls []launchCall
	runInSession = func(binary string, args []string, session uint32, timeout time.Duration) (uint32, error) {
		calls = append(calls, launchCall{"run", binary, args, session, timeout})
		return killCode, killErr
	}
	spawnInSession = func(binary string, args []string, session uint32) (uint32, error) {
		calls = append(calls, launchCall{"spawn", binary, args, session, 0})
		return 4242, nil
	}
	return &calls
}

const (
	testTaskkill = `C:\Windows\System32\taskkill.exe`
	testOneDrive = `C:\Program Files\Microsoft OneDrive\OneDrive.exe`
)

// #6923: OneDrive is relaunched only after taskkill has finished. Both used
// to be fired off together, so taskkill could kill the new instance too and
// leave the user with no OneDrive at all.
func TestRestartOneDriveInSessionWaitsForTaskkillBeforeRelaunch(t *testing.T) {
	calls := stubSessionLaunchers(t, 0, nil)

	killErr, relaunchErr := restartOneDriveInSession(testTaskkill, testOneDrive, 3)

	if killErr != nil || relaunchErr != nil {
		t.Fatalf("killErr=%v relaunchErr=%v, want both nil", killErr, relaunchErr)
	}
	want := []launchCall{
		{"run", testTaskkill, []string{"/f", "/im", "OneDrive.exe"}, 3, oneDriveKillWait},
		{"spawn", testOneDrive, []string{"/background"}, 3, 0},
	}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("launches = %+v, want %+v", *calls, want)
	}
	if oneDriveKillWait <= 0 {
		t.Fatalf("oneDriveKillWait = %s; the wait must be bounded and non-zero", oneDriveKillWait)
	}
}

// taskkill exits 128 when no process matched: OneDrive was not running, so
// there was nothing to kill and nothing went wrong.
func TestRestartOneDriveInSessionNoOneDriveRunningIsNotAnError(t *testing.T) {
	calls := stubSessionLaunchers(t, 128, nil)

	killErr, relaunchErr := restartOneDriveInSession(testTaskkill, testOneDrive, 3)

	if killErr != nil || relaunchErr != nil {
		t.Fatalf("killErr=%v relaunchErr=%v, want both nil", killErr, relaunchErr)
	}
	if len(*calls) != 2 || (*calls)[1].kind != "spawn" {
		t.Fatalf("launches = %+v, want taskkill then a OneDrive relaunch", *calls)
	}
}

// A taskkill that cannot be launched, overruns the wait or exits with a
// failure still gets a relaunch: "killed and not restarted" is the one outcome
// restartOneDrive must never leave behind. The kill failure is reported.
func TestRestartOneDriveInSessionRelaunchesWhenTaskkillFails(t *testing.T) {
	launchErr := errors.New("CreateProcessAsUser: Access is denied.")
	timeoutErr := errors.New("spawned process did not exit in time")
	for _, tc := range []struct {
		name     string
		code     uint32
		runErr   error
		wantText string
	}{
		{"launch failed", 0, launchErr, "Access is denied"},
		{"wait timed out", 0, timeoutErr, "did not exit in time"},
		{"taskkill exit 1", 1, nil, "exited with code 1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := stubSessionLaunchers(t, tc.code, tc.runErr)

			killErr, relaunchErr := restartOneDriveInSession(testTaskkill, testOneDrive, 2)

			if killErr == nil || !strings.Contains(killErr.Error(), tc.wantText) {
				t.Fatalf("killErr = %v, want an error containing %q", killErr, tc.wantText)
			}
			if tc.runErr != nil && !errors.Is(killErr, tc.runErr) {
				t.Fatalf("killErr = %v, want it to wrap %v", killErr, tc.runErr)
			}
			if relaunchErr != nil {
				t.Fatalf("relaunchErr = %v, want a clean relaunch", relaunchErr)
			}
			if len(*calls) != 2 || (*calls)[1].kind != "spawn" || (*calls)[1].binary != testOneDrive {
				t.Fatalf("launches = %+v, want taskkill then a OneDrive relaunch", *calls)
			}
		})
	}
}
