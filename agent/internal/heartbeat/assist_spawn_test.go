package heartbeat

import (
	"errors"
	"reflect"
	"testing"
)

func stubSpawnProcessInSession(t *testing.T, pid uint32, err error) *[]any {
	t.Helper()
	orig := spawnProcessInSession
	t.Cleanup(func() { spawnProcessInSession = orig })
	var calls []any
	spawnProcessInSession = func(binary string, args []string, session uint32) (uint32, error) {
		calls = append(calls, binary, args, session)
		return pid, err
	}
	return &calls
}

// #6923: the direct Assist launch hands the helper manager the real PID, so
// the watcher tracks the process it started (it used to get 0).
func TestSpawnAssistDirectReturnsLaunchedPID(t *testing.T) {
	calls := stubSpawnProcessInSession(t, 3104, nil)

	pid, err := spawnAssistDirect("2", `C:\Program Files\Breeze Helper\breeze-helper.exe`, []string{"--config", "c.yaml"})

	if err != nil || pid != 3104 {
		t.Fatalf("pid=%d err=%v, want 3104 and no error", pid, err)
	}
	want := []any{`C:\Program Files\Breeze Helper\breeze-helper.exe`, []string{"--config", "c.yaml"}, uint32(2)}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("spawn called with %v, want %v", *calls, want)
	}
}

func TestSpawnAssistDirectFailureReportsNoPID(t *testing.T) {
	launchErr := errors.New("CreateProcessAsUser: Access is denied.")
	stubSpawnProcessInSession(t, 3104, launchErr)

	pid, err := spawnAssistDirect("2", `C:\x\breeze-helper.exe`, nil)

	if !errors.Is(err, launchErr) || pid != 0 {
		t.Fatalf("pid=%d err=%v, want 0 and the launch error", pid, err)
	}
}

func TestSpawnAssistDirectRejectsBadSessionKey(t *testing.T) {
	calls := stubSpawnProcessInSession(t, 3104, nil)

	pid, err := spawnAssistDirect("console", `C:\x\breeze-helper.exe`, nil)

	if err == nil || pid != 0 || len(*calls) != 0 {
		t.Fatalf("pid=%d err=%v launches=%d, want an error and no launch", pid, err, len(*calls)/3)
	}
}
