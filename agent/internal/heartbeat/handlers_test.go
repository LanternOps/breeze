package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// allCommandTypes returns every command type constant defined in tools/types.go.
// This must be kept in sync — the test below will fail if a new constant is added
// but not included here or in a handler registry init().
var allCommandTypes = []string{
	// handlers.go (direct assignments)
	tools.CmdListProcesses, tools.CmdGetProcess, tools.CmdKillProcess,
	tools.CmdListServices, tools.CmdGetService, tools.CmdStartService,
	tools.CmdStopService, tools.CmdRestartService,
	tools.CmdEventLogsList, tools.CmdEventLogsQuery, tools.CmdEventLogGet,
	tools.CmdTasksList, tools.CmdTaskGet, tools.CmdTaskRun,
	tools.CmdTaskEnable, tools.CmdTaskDisable, tools.CmdTaskHistory,
	tools.CmdRegistryKeys, tools.CmdRegistryValues, tools.CmdRegistryGet,
	tools.CmdRegistrySet, tools.CmdRegistryDelete,
	tools.CmdRegistryKeyCreate, tools.CmdRegistryKeyDelete,
	tools.CmdReboot, tools.CmdShutdown, tools.CmdLock,
	tools.CmdCollectSoftware,
	tools.CmdCollectBootPerformance, tools.CmdManageStartupItem,
	tools.CmdFileList, tools.CmdFileRead, tools.CmdFileWrite,
	tools.CmdFileDelete, tools.CmdFileMkdir, tools.CmdFileRename,
	tools.CmdFilesystemAnalysis,
	tools.CmdTerminalStart, tools.CmdTerminalData,
	tools.CmdTerminalResize, tools.CmdTerminalStop,

	// handlers_desktop.go init()
	tools.CmdFileTransfer, tools.CmdCancelTransfer,
	tools.CmdStartDesktop, tools.CmdStopDesktop,
	tools.CmdDesktopStreamStart, tools.CmdDesktopStreamStop,
	tools.CmdDesktopInput, tools.CmdDesktopConfig,

	// handlers_script.go init()
	tools.CmdScript, tools.CmdRunScript,
	tools.CmdScriptCancel, tools.CmdScriptListRunning,

	// handlers_patch.go init()
	tools.CmdPatchScan, tools.CmdInstallPatches, tools.CmdRollbackPatches,
	tools.CmdDownloadPatches,
	tools.CmdScheduleReboot, tools.CmdCancelReboot, tools.CmdGetRebootStatus,

	// handlers_network.go init()
	tools.CmdNetworkDiscovery, tools.CmdSnmpPoll,
	tools.CmdNetworkPing, tools.CmdNetworkTcpCheck,
	tools.CmdNetworkHttpCheck, tools.CmdNetworkDnsCheck,

	// handlers_security.go init()
	tools.CmdSecurityCollectStatus, tools.CmdSecurityScan,
	tools.CmdSecurityThreatQuarantine, tools.CmdSecurityThreatRemove,
	tools.CmdSecurityThreatRestore,

	// handlers_patch.go init() — backup
	tools.CmdBackupRun, tools.CmdBackupList, tools.CmdBackupStop,

	// handlers_user.go init()
	CmdNotifyUser, CmdTrayUpdate,

	// handlers.go — log shipping
	tools.CmdSetLogLevel,

	// handlers_devupdate.go init()
	tools.CmdDevUpdate,

	// handlers_screenshot.go + handlers_computer_action.go init()
	tools.CmdTakeScreenshot, tools.CmdComputerAction,
}

func TestHandlerRegistryCompleteness(t *testing.T) {
	for _, cmdType := range allCommandTypes {
		if _, ok := handlerRegistry[cmdType]; !ok {
			t.Errorf("command type %q has no handler in handlerRegistry", cmdType)
		}
	}
}

func TestHandlerRegistryNoExtraEntries(t *testing.T) {
	known := make(map[string]bool, len(allCommandTypes))
	for _, ct := range allCommandTypes {
		known[ct] = true
	}
	for cmdType := range handlerRegistry {
		if !known[cmdType] {
			t.Errorf("handlerRegistry contains unknown command type %q — add it to allCommandTypes", cmdType)
		}
	}
}

func TestDispatchUnknownCommandReturnsFalse(t *testing.T) {
	h := &Heartbeat{}
	_, handled := h.dispatchCommand(Command{
		ID:   "test-1",
		Type: "nonexistent_command",
	})
	if handled {
		t.Fatal("dispatchCommand should return false for unknown command type")
	}
}
