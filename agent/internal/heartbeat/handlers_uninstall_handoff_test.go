package heartbeat

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/selfuninstall"
)

type handoffRecorder struct {
	calls     []string
	spawnName string
	spawnArgs []string
	stageErr  error
	spawnErr  error
}

func (r *handoffRecorder) deps() windowsUninstallHandoff {
	return windowsUninstallHandoff{
		executable: func() (string, error) { return `C:\Program Files\Breeze\breeze-agent.exe`, nil },
		configDir:  func() string { return `C:\ProgramData\Breeze` },
		stageHelper: func(agentExe string) (string, func(), error) {
			r.calls = append(r.calls, "stage "+agentExe)
			if r.stageErr != nil {
				return "", nil, r.stageErr
			}
			return `C:\Windows\SystemTemp\breeze-uninstall-ab\breeze-uninstall-helper.exe`, func() { r.calls = append(r.calls, "cleanup") }, nil
		},
		neutralize: func() { r.calls = append(r.calls, "neutralize") },
		restore:    func() { r.calls = append(r.calls, "restore") },
		spawn: func(name string, args ...string) error {
			r.calls = append(r.calls, "spawn")
			r.spawnName, r.spawnArgs = name, args
			return r.spawnErr
		},
	}
}

// #11154: the helper copy is staged BEFORE phase 1 touches anything, then the
// watchdog/service are neutralized, then the helper is spawned with what it
// needs to tear down, verify and report this command.
func TestWindowsHandoffStagesNeutralizesThenSpawnsTheHelper(t *testing.T) {
	r := &handoffRecorder{}
	err := prepareSelfUninstallWindows(selfUninstallRequest{CommandID: "3bb7ac81-be24-4206-8896-f5cf7dbea12b", RemoveConfig: false}, r.deps())
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	want := []string{`stage C:\Program Files\Breeze\breeze-agent.exe`, "neutralize", "spawn"}
	if !reflect.DeepEqual(r.calls, want) {
		t.Fatalf("calls = %v, want %v", r.calls, want)
	}
	if !strings.HasSuffix(r.spawnName, selfuninstall.HelperExeName) {
		t.Fatalf("spawned %q, want the staged helper copy", r.spawnName)
	}
	wantArgs := []string{
		selfuninstall.FinishCommand,
		"--command-id", "3bb7ac81-be24-4206-8896-f5cf7dbea12b",
		"--agent-binary", `C:\Program Files\Breeze\breeze-agent.exe`,
		"--config-dir", `C:\ProgramData\Breeze`,
		"--remove-config=false",
	}
	if !reflect.DeepEqual(r.spawnArgs, wantArgs) {
		t.Fatalf("spawn args = %q, want %q", r.spawnArgs, wantArgs)
	}
}

// Staging failing leaves the machine exactly as it was.
func TestWindowsHandoffStageFailureTouchesNothing(t *testing.T) {
	r := &handoffRecorder{stageErr: errors.New("temp dir refused")}
	err := prepareSelfUninstallWindows(selfUninstallRequest{CommandID: "c", RemoveConfig: true}, r.deps())
	if err == nil || !strings.Contains(err.Error(), "temp dir refused") {
		t.Fatalf("err = %v", err)
	}
	if !reflect.DeepEqual(r.calls, []string{`stage C:\Program Files\Breeze\breeze-agent.exe`}) {
		t.Fatalf("calls = %v, want only the stage attempt", r.calls)
	}
}

// A helper that cannot be spawned will not uninstall anything: phase 1's
// service changes are undone (the agent keeps auto-starting and its recovery
// actions) and the staged copy is removed.
func TestWindowsHandoffSpawnFailureUndoesPhaseOne(t *testing.T) {
	r := &handoffRecorder{spawnErr: errors.New("blocked by policy")}
	err := prepareSelfUninstallWindows(selfUninstallRequest{CommandID: "c", RemoveConfig: true}, r.deps())
	if err == nil || !strings.Contains(err.Error(), "blocked by policy") {
		t.Fatalf("err = %v", err)
	}
	want := []string{`stage C:\Program Files\Breeze\breeze-agent.exe`, "neutralize", "spawn", "restore", "cleanup"}
	if !reflect.DeepEqual(r.calls, want) {
		t.Fatalf("calls = %v, want %v", r.calls, want)
	}
}

// The helper waits as long as the agent's own shutdown schedule assumes.
func TestUninstallHandoffDelayMatchesTheHelper(t *testing.T) {
	if got := time.Duration(uninstallHelperDelaySeconds) * time.Second; got != selfuninstall.HandoffDelay {
		t.Fatalf("agent delay %s != helper delay %s", got, selfuninstall.HandoffDelay)
	}
}
