package heartbeat

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// CommandHandler processes a command and returns a result.
type CommandHandler func(h *Heartbeat, cmd Command) tools.CommandResult

// handlerRegistry maps command types to their handlers.
// Additional handlers are registered via init() in handlers_*.go files.
// This map is only written during package init and read-only thereafter.
var handlerRegistry = map[string]CommandHandler{
	// Process management
	tools.CmdListProcesses: handleListProcesses,
	tools.CmdGetProcess:    handleGetProcess,
	tools.CmdKillProcess:   handleKillProcess,

	// Service management
	tools.CmdListServices:   handleListServices,
	tools.CmdGetService:     handleGetService,
	tools.CmdStartService:   handleStartService,
	tools.CmdStopService:    handleStopService,
	tools.CmdRestartService: handleRestartService,

	// Event logs (Windows)
	tools.CmdEventLogsList:  handleEventLogsList,
	tools.CmdEventLogsQuery: handleEventLogsQuery,
	tools.CmdEventLogGet:    handleEventLogGet,

	// Scheduled tasks (Windows)
	tools.CmdTasksList:   handleTasksList,
	tools.CmdTaskGet:     handleTaskGet,
	tools.CmdTaskRun:     handleTaskRun,
	tools.CmdTaskEnable:  handleTaskEnable,
	tools.CmdTaskDisable: handleTaskDisable,
	tools.CmdTaskHistory: handleTaskHistory,

	// Registry (Windows)
	tools.CmdRegistryKeys:      handleRegistryKeys,
	tools.CmdRegistryValues:    handleRegistryValues,
	tools.CmdRegistryGet:       handleRegistryGet,
	tools.CmdRegistrySet:       handleRegistrySet,
	tools.CmdRegistryDelete:    handleRegistryDelete,
	tools.CmdRegistryKeyCreate: handleRegistryKeyCreate,
	tools.CmdRegistryKeyDelete: handleRegistryKeyDelete,

	// System
	tools.CmdReboot:         handleReboot,
	tools.CmdShutdown:       handleShutdown,
	tools.CmdLock:           handleLock,
	tools.CmdRebootSafeMode: handleRebootSafeMode,
	tools.CmdWakeOnLan:      handleWakeOnLan,

	// On-demand inventory refresh
	tools.CmdRefreshInventory: handleRefreshInventory,

	// Software inventory
	tools.CmdCollectSoftware:   handleCollectSoftware,
	tools.CmdSoftwareUninstall: handleSoftwareUninstall,
	tools.CmdSoftwareUpdate:    handleSoftwareUpdate,

	// Boot performance
	tools.CmdCollectBootPerformance:    handleCollectBootPerformance,
	tools.CmdManageStartupItem:         handleManageStartupItem,
	tools.CmdCollectReliabilityMetrics: handleCollectReliabilityMetrics,

	// Audit policy compliance
	tools.CmdCollectAuditPolicy:       handleCollectAuditPolicy,
	tools.CmdApplyAuditPolicyBaseline: handleApplyAuditPolicyBaseline,

	// File operations
	tools.CmdFileList:           handleFileList,
	tools.CmdFileRead:           handleFileRead,
	tools.CmdFileWrite:          handleFileWrite,
	tools.CmdFileDelete:         handleFileDelete,
	tools.CmdFileMkdir:          handleFileMkdir,
	tools.CmdFileRename:         handleFileRename,
	tools.CmdFileCopy:           handleFileCopy,
	tools.CmdFileTrashList:      handleFileTrashList,
	tools.CmdFileTrashRestore:   handleFileTrashRestore,
	tools.CmdFileTrashPurge:     handleFileTrashPurge,
	tools.CmdFilesystemAnalysis: handleFilesystemAnalysis,
	tools.CmdFileListDrives:     handleFileListDrives,

	// Terminal commands
	tools.CmdTerminalStart:  handleTerminalStart,
	tools.CmdTerminalData:   handleTerminalData,
	tools.CmdTerminalResize: handleTerminalResize,
	tools.CmdTerminalStop:   handleTerminalStop,

	// Log shipping
	tools.CmdSetLogLevel: handleSetLogLevel,

	// Runtime diagnostics — on-demand pprof capture (#2389)
	tools.CmdCapturePprof: handleCapturePprof,

	// Auto-update management
	tools.CmdSetAutoUpdate:   handleSetAutoUpdate,
	tools.CmdAgentRollbackV1: handleAgentRollback,
}

// dispatchCommand looks up the handler for a command type and executes it,
// centralizing timing measurement. If the handler sets DurationMs > 0 (because
// it measures its own timing), that value is preserved. Returns false if no
// handler was found.
func (h *Heartbeat) dispatchCommand(cmd Command) (tools.CommandResult, bool) {
	handler, ok := handlerRegistry[cmd.Type]
	if !ok {
		log.Warn("no handler registered for command type", "type", cmd.Type)
		return tools.CommandResult{}, false
	}
	start := time.Now()
	result := handler(h, cmd)
	// Only override DurationMs if the handler did not set it.
	// Handlers that measure their own duration set a positive value.
	if result.DurationMs <= 0 {
		result.DurationMs = time.Since(start).Milliseconds()
	}
	return result, true
}

// --- Handlers for commands delegated to the tools package ---

func handleListProcesses(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListProcesses(cmd.Payload)
}

func handleGetProcess(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.GetProcess(cmd.Payload)
}

func handleKillProcess(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.KillProcess(cmd.Payload)
}

func handleListServices(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListServices(cmd.Payload)
}

func handleGetService(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.GetService(cmd.Payload)
}

func handleStartService(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.StartService(cmd.Payload)
}

func handleStopService(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.StopService(cmd.Payload)
}

func handleRestartService(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.RestartService(cmd.Payload)
}

func handleEventLogsList(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListEventLogs(cmd.Payload)
}

func handleEventLogsQuery(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.QueryEventLogs(cmd.Payload)
}

func handleEventLogGet(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.GetEventLogEntry(cmd.Payload)
}

func handleTasksList(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListTasks(cmd.Payload)
}

func handleTaskGet(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.GetTask(cmd.Payload)
}

func handleTaskRun(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.RunTask(cmd.Payload)
}

func handleTaskEnable(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.EnableTask(cmd.Payload)
}

func handleTaskDisable(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.DisableTask(cmd.Payload)
}

func handleTaskHistory(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.GetTaskHistory(cmd.Payload)
}

func handleRegistryKeys(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListRegistryKeys(cmd.Payload)
}

func handleRegistryValues(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListRegistryValues(cmd.Payload)
}

func handleRegistryGet(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.GetRegistryValue(cmd.Payload)
}

func handleRegistrySet(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.SetRegistryValue(cmd.Payload)
}

func handleRegistryDelete(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.DeleteRegistryValue(cmd.Payload)
}

func handleRegistryKeyCreate(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.CreateRegistryKey(cmd.Payload)
}

func handleRegistryKeyDelete(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.DeleteRegistryKey(cmd.Payload)
}

func handleReboot(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.Reboot(cmd.Payload)
}

func handleShutdown(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.Shutdown(cmd.Payload)
}

func handleLock(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.Lock(cmd.Payload)
}

func handleWakeOnLan(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.WakeOnLan(cmd.Payload)
}

// handleRefreshInventory triggers an immediate run of the full inventory cycle
// (hardware, software, disk, network, configuration changes, sessions,
// connections, patches, policy state, security status, Apple warranty). Most
// collectors are dispatched via h.sendInventory(); hardware, patch, security,
// and session inventory are dispatched separately here because they run on
// their own cadences (daily / 5-min) and are no longer in the sendInventory
// fan-out. Each runs in its own goroutine; the returned result acknowledges the
// dispatch synchronously while data flows in over the next 30s–2min.
func handleRefreshInventory(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.sendInventoryFn != nil {
		h.sendInventoryFn()
	} else {
		h.sendInventory()
		// Hardware, patch, security, and session inventory run on their own
		// cadences (daily / 5-min) and are no longer part of the sendInventory
		// fan-out, so dispatch them explicitly here to keep "Refresh Inventory" a
		// full refresh of everything in the dispatched list below.
		go h.sendHardwareInventory()
		go h.sendPatchInventory()
		go h.sendSecurityStatus()
		go h.sendSessionInventory()
		// Reset the daily gates so the scheduler doesn't immediately re-run the
		// hardware/patch scans right after this manual refresh.
		h.mu.Lock()
		h.lastHardwareUpdate = time.Now()
		h.lastPatchUpdate = time.Now()
		h.mu.Unlock()
	}
	return tools.NewSuccessResult(map[string]any{
		"dispatched": []string{
			"hardware",
			"software",
			"disk",
			"network",
			"configuration_changes",
			"session",
			"connections",
			"patch",
			"policy_registry",
			"policy_config",
			"security_status",
			"apple_warranty",
		},
	}, time.Since(start).Milliseconds())
}

func handleRebootSafeMode(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	// Resolve the delay up front, through the same helper RebootToSafeMode
	// uses, for two reasons (issue #3373):
	//   1. The notification below must announce the delay the reboot is
	//      actually scheduled with. Reading the raw payload separately let the
	//      toast and the scheduled reboot disagree once either side clamped.
	//   2. A malformed delay must fail the command here, before anything is
	//      broadcast — otherwise users are warned of, and then subjected to, an
	//      immediate forced reboot they never asked for.
	delay, err := tools.ShutdownDelayMinutes(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	if h.sessionBroker != nil {
		h.sessionBroker.BroadcastNotification("Safe Mode Reboot", safeModeRebootNotice(delay), "critical")
	}
	return tools.RebootToSafeMode(cmd.Payload)
}

// safeModeRebootNotice renders the user-facing Safe Mode warning for a delay
// that has already been parsed and clamped by tools.ShutdownDelayMinutes.
func safeModeRebootNotice(delayMinutes int) string {
	if delayMinutes <= 0 {
		return "System is rebooting into Safe Mode with Networking. Please save all work."
	}
	unit := "minutes"
	if delayMinutes == 1 {
		unit = "minute"
	}
	return fmt.Sprintf("System will reboot into Safe Mode with Networking in %d %s. Please save all work.", delayMinutes, unit)
}

func handleCollectSoftware(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	collector := collectors.NewSoftwareCollector()
	software, err := collectors.Guard("software", collector.Collect)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(software, time.Since(start).Milliseconds())
}

// uninstallSoftware is indirected so the re-report gating in
// handleSoftwareUninstall can be tested on both a successful and a failed
// uninstall without running a real package manager.
var uninstallSoftware = tools.UninstallSoftware

// handleSoftwareUninstall removes software and, on success, immediately
// re-reports software inventory.
//
// Without the re-report the dashboard keeps showing the uninstalled program for
// up to 15 minutes (the sendInventory cadence), which is operationally
// indistinguishable from the "uninstall silently did nothing" bug also fixed in
// #3592.
//
// Firing immediately does not race a still-running uninstaller: every path in
// tools.UninstallSoftware is synchronous, and the provider paths additionally
// confirm the software is gone from the collector before reporting success. A
// re-report is idempotent anyway — the API replaces the device's whole software
// list per report — so the worst case is a redundant PUT.
func handleSoftwareUninstall(h *Heartbeat, cmd Command) tools.CommandResult {
	result := uninstallSoftware(cmd.Payload)
	if result.Status == "completed" && h != nil {
		if h.sendSoftwareInventoryFn != nil {
			h.sendSoftwareInventoryFn()
		} else {
			go h.sendSoftwareInventory()
		}
	}
	return result
}

func handleSoftwareUpdate(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.UpdateSoftware(cmd.Payload)
}

func handleFileList(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListFiles(cmd.Payload)
}

func handleFileRead(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ReadFile(cmd.Payload)
}

func handleFileWrite(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.WriteFile(cmd.Payload)
}

func handleFileDelete(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.DeleteFile(cmd.Payload)
}

func handleFileMkdir(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.MakeDirectory(cmd.Payload)
}

func handleFileRename(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.RenameFile(cmd.Payload)
}

func handleFileCopy(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.CopyFile(cmd.Payload)
}

func handleFileTrashList(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TrashList(cmd.Payload)
}

func handleFileTrashRestore(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TrashRestore(cmd.Payload)
}

func handleFileTrashPurge(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.TrashPurge(cmd.Payload)
}

func handleFilesystemAnalysis(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.AnalyzeFilesystem(cmd.Payload)
}

func handleFileListDrives(_ *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ListDrives(cmd.Payload)
}

func handleTerminalStart(h *Heartbeat, cmd Command) tools.CommandResult {
	log.Info("handleTerminalStart ENTER", "cmdId", cmd.ID)
	result := tools.StartTerminal(h.terminalMgr, cmd.Payload, h.sendTerminalOutput)
	log.Info("handleTerminalStart EXIT", "cmdId", cmd.ID, "status", result.Status, "error", result.Error)
	return result
}

func handleTerminalData(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.WriteTerminal(h.terminalMgr, cmd.Payload)
}

func handleTerminalResize(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.ResizeTerminal(h.terminalMgr, cmd.Payload)
}

func handleTerminalStop(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.StopTerminal(h.terminalMgr, cmd.Payload)
}

func handleCollectBootPerformance(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	metrics, err := collectors.Guard("bootPerformance", h.bootCol.Collect)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(metrics, time.Since(start).Milliseconds())
}

func handleManageStartupItem(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	name := tools.GetPayloadString(cmd.Payload, "itemName", "")
	itemType := tools.GetPayloadString(cmd.Payload, "itemType", "")
	itemPath := tools.GetPayloadString(cmd.Payload, "itemPath", "")
	action := tools.GetPayloadString(cmd.Payload, "action", "")

	if name == "" || action == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing required fields: itemName and action",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}
	if action != "disable" && action != "enable" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "action must be 'disable' or 'enable'",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	err := collectors.ManageStartupItem(name, itemType, itemPath, action)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(map[string]string{
		"message": fmt.Sprintf("Startup item '%s' %sd successfully", name, action),
	}, time.Since(start).Milliseconds())
}

func handleCollectReliabilityMetrics(h *Heartbeat, _ Command) tools.CommandResult {
	start := time.Now()
	if h.reliabilityCol == nil {
		return tools.NewErrorResult(fmt.Errorf("reliability collector unavailable"), time.Since(start).Milliseconds())
	}

	metrics, err := collectors.Guard("reliability", h.reliabilityCol.Collect)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	return tools.NewSuccessResult(metrics, time.Since(start).Milliseconds())
}
