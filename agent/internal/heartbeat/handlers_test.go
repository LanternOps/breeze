package heartbeat

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop"
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
	tools.CmdReboot, tools.CmdShutdown, tools.CmdLock, tools.CmdRebootSafeMode, tools.CmdWakeOnLan,
	tools.CmdRefreshInventory,
	tools.CmdCollectSoftware, tools.CmdSoftwareUninstall, tools.CmdSoftwareInstall, tools.CmdSoftwareUpdate,

	// handlers_homebrew_bootstrap.go init()
	tools.CmdHomebrewBootstrap,
	tools.CmdCollectBootPerformance, tools.CmdManageStartupItem,
	tools.CmdCollectReliabilityMetrics,
	tools.CmdCollectAuditPolicy, tools.CmdApplyAuditPolicyBaseline,
	tools.CmdFileList, tools.CmdFileRead, tools.CmdFileWrite,
	tools.CmdFileDelete, tools.CmdFileMkdir, tools.CmdFileRename,
	tools.CmdFileCopy, tools.CmdFileListDrives,
	tools.CmdFileTrashList, tools.CmdFileTrashRestore, tools.CmdFileTrashPurge,
	tools.CmdFilesystemAnalysis,
	tools.CmdSystemCleanupList, tools.CmdSystemCleanupRun,
	tools.CmdTerminalStart, tools.CmdTerminalData,
	tools.CmdTerminalResize, tools.CmdTerminalStop,

	// handlers_desktop.go init()
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
	tools.CmdNetworkDiagnostic, tools.CmdNetworkDiagnosticCancel,
	tools.CmdNetworkPing, tools.CmdNetworkTcpCheck,
	tools.CmdNetworkHttpCheck, tools.CmdNetworkDnsCheck,

	// handlers_security.go init()
	tools.CmdSecurityCollectStatus, tools.CmdSecurityScan,
	tools.CmdSecurityThreatQuarantine, tools.CmdSecurityThreatRemove,
	tools.CmdSecurityThreatRestore,
	tools.CmdSensitiveDataScan, tools.CmdQuarantineFile,
	tools.CmdEncryptFile, tools.CmdSecureDeleteFile,

	// handlers_backup_forward.go init() — backup commands forwarded to breeze-backup via IPC
	tools.CmdBackupRun, tools.CmdBackupList, tools.CmdBackupStop, tools.CmdBackupRestore,

	// handlers_backup_verify_forward.go init()
	tools.CmdBackupVerify, tools.CmdBackupTestRestore, tools.CmdBackupCleanup,

	// handlers_vss_forward.go init()
	tools.CmdVSSStatus, tools.CmdVSSWriterList,

	// handlers_mssql_forward.go init()
	tools.CmdMSSQLDiscover, tools.CmdMSSQLBackup, tools.CmdMSSQLRestore, tools.CmdMSSQLVerify,

	// handlers_hyperv_forward.go init()
	tools.CmdHypervDiscover, tools.CmdHypervBackup, tools.CmdHypervRestore,
	tools.CmdHypervCheckpoint, tools.CmdHypervVMState,

	// handlers_systemstate_forward.go init()
	tools.CmdSystemStateCollect, tools.CmdHardwareProfile,

	// handlers_bmr_forward.go init()
	tools.CmdVMRestoreEstimate, tools.CmdVMRestoreFromBackup, tools.CmdBMRRecover,
	tools.CmdBareMetalRebuild,

	// handlers_user.go init()
	CmdNotifyUser, CmdTrayUpdate,

	// handlers.go — log shipping
	tools.CmdSetLogLevel,

	// handlers.go — runtime diagnostics (handlers_diag.go)
	tools.CmdCapturePprof,

	// handlers_autoupdate.go
	tools.CmdSetAutoUpdate,
	// handlers_rollback.go
	tools.CmdAgentRollbackV1,

	// handlers_devupdate.go init()
	tools.CmdDevUpdate,

	// handlers_screenshot.go + handlers_computer_action.go init()
	tools.CmdTakeScreenshot, tools.CmdComputerAction,

	// handlers_desktop.go init() — session management
	tools.CmdListSessions,

	// handlers_cis.go init()
	tools.CmdCisBenchmark, tools.CmdApplyCisRemediation,

	// handlers_peripheral.go init()
	tools.CmdPeripheralPolicySync,
	// handlers_peripheral_v2.go init()
	tools.CmdPeripheralPolicySyncV2,

	// handlers_uninstall.go init()
	tools.CmdSelfUninstall,

	// handlers_support.go init()
	tools.CmdSupportEnd,

	// handlers_incident_response.go init()
	tools.CmdCollectEvidence, tools.CmdExecuteContainment,

	// handlers_tunnel.go init()
	tools.CmdTunnelOpen, tools.CmdTunnelData, tools.CmdTunnelClose,
	tools.CmdHttpRequest,

	// handlers_actuate.go init() — PAM Track 5
	tools.CmdActuateElevation,
	tools.CmdPamApplyV2, tools.CmdPamCleanupV2,

	// handlers_encryption.go init()
	tools.CmdEncryptionCollectKeys, tools.CmdEncryptionRotateKey,
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

func TestHandleRefreshInventoryDispatchesSendInventory(t *testing.T) {
	var called int
	h := &Heartbeat{
		sendInventoryFn: func() { called++ },
	}

	result := handleRefreshInventory(h, Command{ID: "test-refresh-1", Type: tools.CmdRefreshInventory})

	if called != 1 {
		t.Fatalf("sendInventoryFn called %d times, want 1", called)
	}
	if result.Status != "completed" {
		t.Errorf("result.Status = %q, want %q", result.Status, "completed")
	}
	if result.ExitCode != 0 {
		t.Errorf("result.ExitCode = %d, want 0", result.ExitCode)
	}
	var payload struct {
		Dispatched []string `json:"dispatched"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("result.Stdout not valid JSON: %v (stdout=%q)", err, result.Stdout)
	}
	if len(payload.Dispatched) != 12 {
		t.Errorf("dispatched len = %d, want 12 (one per send*Inventory collector)", len(payload.Dispatched))
	}
}

func TestHandleDesktopStreamStartPassesDisplayIndex(t *testing.T) {
	var gotDisplayIndex int
	h := &Heartbeat{
		wsDesktopStart: func(sessionID string, displayIndex int, config desktop.StreamConfig, sendFrame desktop.SendFrameFunc) (int, int, error) {
			gotDisplayIndex = displayIndex
			return 1920, 1080, nil
		},
	}

	result := handleDesktopStreamStart(h, Command{
		ID:   "desktop-stream-1",
		Type: tools.CmdDesktopStreamStart,
		Payload: map[string]any{
			"sessionId":    "ws-1",
			"displayIndex": float64(2),
		},
	})

	if result.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", result.Status, result.Error)
	}
	if gotDisplayIndex != 2 {
		t.Fatalf("displayIndex = %d, want 2", gotDisplayIndex)
	}
}

// TestNetworkDiscoveryResultIncludesAdjacencyKey asserts the network_discovery
// result payload always carries an "adjacency" key (issue #1728, Phase 1).
// CommandResult marshals the payload map into Stdout as JSON (there is no
// Result field), so the key presence is asserted via the unmarshalled object.
func TestNetworkDiscoveryResultIncludesAdjacencyKey(t *testing.T) {
	cmd := Command{
		Type:    tools.CmdNetworkDiscovery,
		Payload: map[string]any{"jobId": "job-1", "subnets": []any{"127.0.0.1/32"}, "methods": []any{"ping"}, "timeout": float64(1)},
	}
	res := handleNetworkDiscovery(nil, cmd)
	if res.Status != "completed" {
		t.Fatalf("expected completed, got %s (%s)", res.Status, res.Error)
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &data); err != nil {
		t.Fatalf("result.Stdout not valid JSON: %v (stdout=%q)", err, res.Stdout)
	}
	if _, present := data["adjacency"]; !present {
		t.Fatalf("expected 'adjacency' key in discovery result payload, got keys: %v", data)
	}
}

// Disk Cleanup v2 W04. The registry-completeness tests above already fail if
// either type is unregistered; these pin the wire strings, which the API's
// CommandTypes table, COMMAND_OFFLINE_POLICY_REGISTRY, partnerTrust
// GATED_COMMAND_TYPES and commandTimeouts all mirror.
func TestSystemCleanupCommandTypeStrings(t *testing.T) {
	if tools.CmdSystemCleanupList != "system_cleanup_list" {
		t.Fatalf("CmdSystemCleanupList = %q", tools.CmdSystemCleanupList)
	}
	if tools.CmdSystemCleanupRun != "system_cleanup_run" {
		t.Fatalf("CmdSystemCleanupRun = %q", tools.CmdSystemCleanupRun)
	}
}

func TestSystemCleanupListReturnsAParseableCatalogue(t *testing.T) {
	h := &Heartbeat{}
	result, handled := h.dispatchCommand(Command{ID: "c1", Type: tools.CmdSystemCleanupList, Payload: map[string]any{}})
	if !handled {
		t.Fatal("system_cleanup_list has no handler")
	}
	if result.Status != "completed" {
		t.Fatalf("status = %q, error = %q", result.Status, result.Error)
	}
	var payload struct {
		CatalogVersion int `json:"catalogVersion"`
		Actions        []struct {
			ID            string `json:"id"`
			EstimateKnown bool   `json:"estimateKnown"`
		} `json:"actions"`
		VolumesBefore []struct {
			Mount string `json:"mount"`
		} `json:"volumesBefore"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("catalogue stdout is not JSON: %v", err)
	}
	if payload.CatalogVersion != 1 {
		t.Fatalf("catalogVersion = %d, want 1", payload.CatalogVersion)
	}
}

// A run with no runId is a programming error on the server, not something to
// execute against a customer's machine with an unattributable result.
func TestSystemCleanupRunRequiresARunID(t *testing.T) {
	h := &Heartbeat{}
	result, handled := h.dispatchCommand(Command{
		ID:      "c2",
		Type:    tools.CmdSystemCleanupRun,
		Payload: map[string]any{"actionIds": []any{"linux_journal_vacuum"}},
	})
	if !handled {
		t.Fatal("system_cleanup_run has no handler")
	}
	if result.Status != "failed" || !strings.Contains(result.Error, "runId") {
		t.Fatalf("result = %+v, want a failure naming runId", result)
	}
}

// An empty selection must not be treated as "run everything".
func TestSystemCleanupRunRejectsAnEmptySelection(t *testing.T) {
	h := &Heartbeat{}
	result, _ := h.dispatchCommand(Command{
		ID:      "c3",
		Type:    tools.CmdSystemCleanupRun,
		Payload: map[string]any{"runId": "11111111-1111-4111-8111-111111111111", "actionIds": []any{}},
	})
	if result.Status != "failed" || !strings.Contains(result.Error, "actionIds") {
		t.Fatalf("result = %+v, want a failure naming actionIds", result)
	}
}
