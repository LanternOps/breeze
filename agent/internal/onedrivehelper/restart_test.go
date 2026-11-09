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

func stubSessionLaunchers(t *testing.T, runErr error) *[]launchCall {
	t.Helper()
	origRun, origSpawn := runInSession, spawnInSession
	t.Cleanup(func() { runInSession, spawnInSession = origRun, origSpawn })
	var calls []launchCall
	runInSession = func(binary string, args []string, session uint32, timeout time.Duration) (uint32, error) {
		calls = append(calls, launchCall{"run", binary, args, session, timeout})
		return 0, runErr
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
	calls := stubSessionLaunchers(t, nil)

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

// A taskkill that cannot be launched, exits non-zero (no OneDrive running) or
// overruns the wait still gets a relaunch: "killed and not restarted" is the
// one outcome restartOneDrive must never leave behind.
func TestRestartOneDriveInSessionRelaunchesWhenTaskkillFails(t *testing.T) {
	for _, runErr := range []error{
		errors.New("CreateProcessAsUser: Access is denied."),
		errors.New("spawned process did not exit in time"),
	} {
		t.Run(strings.Fields(runErr.Error())[0], func(t *testing.T) {
			calls := stubSessionLaunchers(t, runErr)

			killErr, relaunchErr := restartOneDriveInSession(testTaskkill, testOneDrive, 2)

			if !errors.Is(killErr, runErr) || relaunchErr != nil {
				t.Fatalf("killErr=%v relaunchErr=%v, want the taskkill error and a clean relaunch", killErr, relaunchErr)
			}
			if len(*calls) != 2 || (*calls)[1].kind != "spawn" || (*calls)[1].binary != testOneDrive {
				t.Fatalf("launches = %+v, want taskkill then a OneDrive relaunch", *calls)
			}
		})
	}
}
