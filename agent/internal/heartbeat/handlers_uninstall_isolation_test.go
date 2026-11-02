package heartbeat

import (
	"context"
	"errors"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
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

func TestUninstallUnsupportedPlatformCleanJournal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unsupported platform contract")
	}
	oldPrepare, oldSchedule := prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn
	t.Cleanup(func() { prepareSelfUninstallFn, scheduleSelfUninstallShutdownFn = oldPrepare, oldSchedule })
	for _, phase := range []journal.Phase{"", journal.PhaseNone, journal.PhaseReleased, journal.PhaseRolledBack} {
		t.Run(string(phase), func(t *testing.T) {
			dir := t.TempDir()
			if phase != "" {
				j := journal.New()
				j.Phase = phase
				if err := journal.Save(journal.Path(dir), j); err != nil {
					t.Fatal(err)
				}
			}
			m := isolation.NewManager(isolation.ManagerDeps{DataDir: dir, Isolator: isolation.NewPlatformIsolator(), Scheduler: isolation.NewPlatformScheduler(dir)})
			prepared, shutdown := false, false
			prepareSelfUninstallFn = func(bool) error { prepared = true; return nil }
			scheduleSelfUninstallShutdownFn = func(*Heartbeat) { shutdown = true }
			result := handleSelfUninstall(&Heartbeat{containment: newContainmentRuntime(m)}, Command{})
			if result.Status != "completed" || !prepared || !shutdown {
				t.Fatalf("clean unsupported uninstall = %+v prepare=%v shutdown=%v", result, prepared, shutdown)
			}
		})
	}
}

func TestWindowsUninstallReleaseGuardGolden(t *testing.T) {
	script := buildWindowsUninstallScript(windowsUninstallScriptOptions{AgentBinaryPath: `C:\O'Brien\breeze-agent.exe`, ServiceName: "BreezeAgent", WatchdogServiceName: "BreezeWatchdog", DelaySeconds: 5})
	want := "try {\r\n  & 'C:\\O''Brien\\breeze-agent.exe' containment release-all --reason uninstall\r\n  if ($LASTEXITCODE -ne 0) { exit 1 }\r\n} catch { exit 1 }\r\n"
	if !strings.HasPrefix(script, want) {
		t.Fatalf("release guard missing or changed:\n%s", script)
	}
	assertOrder(t, script, "containment release-all --reason uninstall", "if ($LASTEXITCODE -ne 0) { exit 1 }", "Start-Sleep -Seconds 5", "sc.exe stop 'BreezeWatchdog'", "Stop-Service -Name 'BreezeAgent'")
}

// Keep the release seam's context-bearing contract explicit for fake managers.
var _ interface {
	ReleaseAll(context.Context, string) error
} = (*isolation.Manager)(nil)
