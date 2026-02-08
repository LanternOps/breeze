package heartbeat

import (
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
	tools.CmdReboot:   handleReboot,
	tools.CmdShutdown: handleShutdown,
	tools.CmdLock:     handleLock,

	// Software inventory
	tools.CmdCollectSoftware: handleCollectSoftware,

	// File operations
	tools.CmdFileList:   handleFileList,
	tools.CmdFileRead:   handleFileRead,
	tools.CmdFileWrite:  handleFileWrite,
	tools.CmdFileDelete: handleFileDelete,
	tools.CmdFileMkdir:  handleFileMkdir,
	tools.CmdFileRename: handleFileRename,

	// Terminal commands
	tools.CmdTerminalStart:  handleTerminalStart,
	tools.CmdTerminalData:   handleTerminalData,
	tools.CmdTerminalResize: handleTerminalResize,
	tools.CmdTerminalStop:   handleTerminalStop,
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

func handleCollectSoftware(_ *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	collector := collectors.NewSoftwareCollector()
	software, err := collector.Collect()
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}
	return tools.NewSuccessResult(software, time.Since(start).Milliseconds())
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

func handleTerminalStart(h *Heartbeat, cmd Command) tools.CommandResult {
	return tools.StartTerminal(h.terminalMgr, cmd.Payload, h.sendTerminalOutput)
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
