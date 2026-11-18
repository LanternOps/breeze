package heartbeat

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestUninstallReleasePrecedesPreparation(t *testing.T) {
	oldRelease, oldPrepare, oldSchedule := releaseIsolationForUninstallFn, prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn
	t.Cleanup(func() {
		releaseIsolationForUninstallFn, prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn = oldRelease, oldPrepare, oldSchedule
	})
	for _, fail := range []bool{false, true} {
		var calls []string
		releaseIsolationForUninstallFn = func(*Heartbeat) error {
			calls = append(calls, "release")
			if fail {
				return errors.New("absence unconfirmed")
			}
			return nil
		}
		prepareSelfUninstallFn = func(bool) error { calls = append(calls, "prepare"); return nil }
		scheduleSelfUninstallShutdownFn = func(*Heartbeat) { calls = append(calls, "shutdown") }
		result := handleSelfUninstall(&Heartbeat{}, Command{})
		want := []string{"release", "prepare", "shutdown"}
		if fail {
			want = []string{"release"}
			if result.Status != "failed" || !strings.Contains(result.Error, "absence unconfirmed") {
				t.Fatalf("release failure = %+v", result)
			}
		} else if result.Status != "completed" {
			t.Fatalf("release success = %+v", result)
		}
		if !reflect.DeepEqual(calls, want) {
			t.Fatalf("calls = %v, want %v", calls, want)
		}
	}
}

// uninstallEngine answers Owned as told. These tests never reach a real firewall
// tool: the platform isolator's answer depends on the host (on Linux, whether
// nft is installed and whether the test runs as root).
type uninstallEngine struct{ ownedErr error }

func (uninstallEngine) Capability() isolation.Capability { return isolation.Capability{} }
func (uninstallEngine) Apply(context.Context, isolation.ResolvedSpec) (isolation.Digest, error) {
	return "", errors.New("uninstall must not apply rules")
}
func (uninstallEngine) Verify(context.Context, isolation.ResolvedSpec) (isolation.Digest, error) {
	return "", errors.New("uninstall must not verify rules")
}
func (uninstallEngine) Release(context.Context) error { return nil }
func (e uninstallEngine) Owned(context.Context) (bool, error) {
	return false, e.ownedErr
}
func (uninstallEngine) Mark(context.Context) (isolation.Marker, error) {
	return isolation.Marker{}, nil
}
func (uninstallEngine) DropObserved(context.Context, isolation.Marker) (bool, error) {
	return false, nil
}

type uninstallScheduler struct{}

func (uninstallScheduler) ArmProvisional(string, time.Time) error { return nil }
func (uninstallScheduler) DisarmProvisional(string) error         { return nil }
func (uninstallScheduler) ArmExpiry(string, int, time.Time) error { return nil }
func (uninstallScheduler) EnsurePoll() error                      { return nil }
func (uninstallScheduler) RemoveAll() error                       { return nil }
func (uninstallScheduler) Ready() (bool, string)                  { return true, "" }

// runUninstallWithEngine runs the handler against a journal in the given phase
// ("" for no journal) and reports whether teardown was handed off.
func runUninstallWithEngine(t *testing.T, phase journal.Phase, engine isolation.Isolator) (result tools.CommandResult, handedOff bool) {
	t.Helper()
	oldPrepare, oldSchedule := prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn
	t.Cleanup(func() { prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn = oldPrepare, oldSchedule })
	dir := t.TempDir()
	if phase != "" {
		j := journal.New()
		j.Phase = phase
		if err := journal.Save(journal.Path(dir), j); err != nil {
			t.Fatal(err)
		}
	}
	m := isolation.NewManager(isolation.ManagerDeps{DataDir: dir, Isolator: engine, Scheduler: uninstallScheduler{}})
	prepared, shutdown := false, false
	prepareSelfUninstallFn = func(bool) error { prepared = true; return nil }
	scheduleSelfUninstallShutdownFn = func(*Heartbeat) { shutdown = true }
	result = handleSelfUninstall(&Heartbeat{containment: newContainmentRuntime(m)}, Command{})
	return result, prepared && shutdown
}

// A build with no engine cannot have installed rules on an idle journal, so it
// must not block uninstall. Linux reaches this when nft is not installed.
func TestUninstallUnsupportedPlatformCleanJournal(t *testing.T) {
	for _, phase := range []journal.Phase{"", journal.PhaseNone, journal.PhaseReleased, journal.PhaseRolledBack} {
		t.Run(string(phase), func(t *testing.T) {
			result, handedOff := runUninstallWithEngine(t, phase, uninstallEngine{ownedErr: isolation.ErrUnsupported})
			if result.Status != "completed" || !handedOff {
				t.Fatalf("clean unsupported uninstall = %+v handedOff=%v", result, handedOff)
			}
		})
	}
}

// An engine that exists but will not answer is different: a journal means this
// host has isolated before, so absence cannot be assumed and uninstall stops.
// Linux reaches this when nft is installed but fails (netlink errors, EPERM).
func TestUninstallRefusedWhenAnIdleJournalsEngineWillNotAnswer(t *testing.T) {
	for _, phase := range []journal.Phase{journal.PhaseNone, journal.PhaseReleased, journal.PhaseRolledBack} {
		t.Run(string(phase), func(t *testing.T) {
			result, handedOff := runUninstallWithEngine(t, phase, uninstallEngine{ownedErr: errors.New("netlink: operation not permitted")})
			if result.Status != "failed" || handedOff {
				t.Fatalf("uninstall with an unconfirmed engine = %+v handedOff=%v", result, handedOff)
			}
			if !strings.Contains(result.Error, "isolation release could not be confirmed") {
				t.Fatalf("error = %q", result.Error)
			}
		})
	}
}

// With no journal at all, nothing was ever isolated here (W1g's rule; see Needs
// Todd on PR #10987 for the open question about a deleted journal).
func TestUninstallProceedsWithNoJournalWhenTheEngineWillNotAnswer(t *testing.T) {
	result, handedOff := runUninstallWithEngine(t, "", uninstallEngine{ownedErr: errors.New("netlink: operation not permitted")})
	if result.Status != "completed" || !handedOff {
		t.Fatalf("uninstall = %+v handedOff=%v", result, handedOff)
	}
}

func TestWindowsUninstallReleaseGuardGolden(t *testing.T) {
	script := buildWindowsUninstallScript(windowsUninstallScriptOptions{AgentBinaryPath: `C:\O'Brien\breeze-agent.exe`, ServiceName: "BreezeAgent", WatchdogServiceName: "BreezeWatchdog", ConfigDir: `C:\ProgramData\Breeze`, DelaySeconds: 5})
	want := "try {\r\n" +
		"  & 'C:\\O''Brien\\breeze-agent.exe' containment release-all --reason uninstall\r\n" +
		"  $breezeReleaseExit = $LASTEXITCODE\r\n" +
		"} catch { $breezeReleaseExit = 1 }\r\n" +
		"if ($breezeReleaseExit -ne 0) {\r\n" +
		"  \"$(Get-Date -Format o) self-uninstall aborted: isolation release could not be confirmed (exit $breezeReleaseExit); agent service re-enabled\" | Out-File -LiteralPath 'C:\\ProgramData\\Breeze\\logs\\uninstall-isolation-release-error.txt' -Append -Encoding utf8 -ErrorAction SilentlyContinue\r\n" +
		"  sc.exe config 'BreezeAgent' start= auto | Out-Null\r\n" +
		"  sc.exe failure 'BreezeAgent' reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null\r\n" +
		"  exit 1\r\n" +
		"}\r\n"
	if !strings.HasPrefix(script, want) {
		t.Fatalf("release guard missing or changed:\n%s", script)
	}
	assertOrder(t, script, "containment release-all --reason uninstall", "sc.exe config 'BreezeAgent' start= auto", "exit 1", "Start-Sleep -Seconds 5", "sc.exe stop 'BreezeWatchdog'", "Stop-Service -Name 'BreezeAgent'")
}

// Phase 1 already disabled the service and cleared its recovery actions; a
// failed release must undo that, or the device is left stopped and disabled
// (#2796) while Breeze-owned filters may remain.
func TestWindowsUninstallReleaseFailureWithoutConfigDirStillRestoresService(t *testing.T) {
	script := buildWindowsUninstallScript(windowsUninstallScriptOptions{AgentBinaryPath: `C:\a\breeze-agent.exe`, ServiceName: "BreezeAgent", WatchdogServiceName: "BreezeWatchdog", DelaySeconds: 5})
	if strings.Contains(script, "Out-File") {
		t.Fatal("no config dir: must not write a log to a relative path")
	}
	assertOrder(t, script, "if ($breezeReleaseExit -ne 0) {", "sc.exe config 'BreezeAgent' start= auto", "exit 1", "Start-Sleep -Seconds 5")
}

// Keep the release seam's context-bearing contract explicit for fake managers.
var _ interface {
	ReleaseAll(context.Context, string) error
} = (*isolation.Manager)(nil)
