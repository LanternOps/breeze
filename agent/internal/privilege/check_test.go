//go:build !windows

package privilege

import (
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// ---------- RequiresElevation — elevated commands ----------

func TestRequiresElevationTrueForElevatedCommands(t *testing.T) {
	elevated := []string{
		tools.CmdReboot,
		tools.CmdShutdown,
		tools.CmdLock,
		tools.CmdStartService,
		tools.CmdStopService,
		tools.CmdRestartService,
		tools.CmdInstallPatches,
		tools.CmdRollbackPatches,
		tools.CmdRegistrySet,
		tools.CmdRegistryDelete,
		tools.CmdRegistryKeyCreate,
		tools.CmdRegistryKeyDelete,
		tools.CmdTaskEnable,
		tools.CmdTaskDisable,
		tools.CmdDownloadPatches,
		tools.CmdScheduleReboot,
		tools.CmdCancelReboot,
		tools.CmdApplyAuditPolicyBaseline,
		tools.CmdEncryptFile,
		tools.CmdSecureDeleteFile,
		tools.CmdQuarantineFile,
	}

	for _, cmd := range elevated {
		t.Run(cmd, func(t *testing.T) {
			if !RequiresElevation(cmd) {
				t.Fatalf("RequiresElevation(%q) = false, want true", cmd)
			}
		})
	}
}

// ---------- RequiresElevation — non-elevated commands ----------

func TestRequiresElevationFalseForNonElevatedCommands(t *testing.T) {
	nonElevated := []string{
		tools.CmdListProcesses,
		tools.CmdGetProcess,
		tools.CmdListServices,
		tools.CmdGetService,
		tools.CmdEventLogsList,
		tools.CmdEventLogsQuery,
		tools.CmdEventLogGet,
		tools.CmdTasksList,
		tools.CmdTaskGet,
		tools.CmdTaskRun,
		tools.CmdTaskHistory,
		tools.CmdRegistryKeys,
		tools.CmdRegistryValues,
		tools.CmdRegistryGet,
		tools.CmdCollectSoftware,
		tools.CmdFileTransfer,
		tools.CmdCancelTransfer,
	}

	for _, cmd := range nonElevated {
		t.Run(cmd, func(t *testing.T) {
			if RequiresElevation(cmd) {
				t.Fatalf("RequiresElevation(%q) = true, want false", cmd)
			}
		})
	}
}

// ---------- RequiresElevation — unknown commands ----------

func TestRequiresElevationFalseForUnknownCommand(t *testing.T) {
	unknowns := []string{
		"",
		"unknown_command",
		"reboot_now",
		"REBOOT",     // case-sensitive
		"Reboot",     // case-sensitive
		"start_service ", // trailing space
		" reboot",       // leading space
	}

	for _, cmd := range unknowns {
		t.Run(cmd, func(t *testing.T) {
			if RequiresElevation(cmd) {
				t.Fatalf("RequiresElevation(%q) = true, want false for unknown command", cmd)
			}
		})
	}
}

// ---------- RequiresElevation — completeness check ----------

func TestElevatedCommandTypesMapNotEmpty(t *testing.T) {
	if len(elevatedCommandTypes) == 0 {
		t.Fatal("elevatedCommandTypes map should not be empty")
	}
}

func TestAllElevatedEntriesAreTrue(t *testing.T) {
	for cmd, val := range elevatedCommandTypes {
		if !val {
			t.Fatalf("elevatedCommandTypes[%q] = false, all entries should be true", cmd)
		}
	}
}

// ---------- IsRunningAsRoot (non-windows) ----------

func TestIsRunningAsRootConsistentWithUid(t *testing.T) {
	// On non-windows, IsRunningAsRoot checks os.Getuid() == 0
	expected := os.Getuid() == 0
	got := IsRunningAsRoot()
	if got != expected {
		t.Fatalf("IsRunningAsRoot() = %v, want %v (uid=%d)", got, expected, os.Getuid())
	}
}

// ---------- RequiresElevation — kill_process is not elevated ----------

func TestKillProcessIsNotElevated(t *testing.T) {
	// kill_process should not require elevation (it is not in the map)
	if RequiresElevation(tools.CmdKillProcess) {
		t.Fatal("kill_process should not require elevation")
	}
}
