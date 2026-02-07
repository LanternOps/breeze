package tools

import (
	"encoding/json"
	"fmt"
	"time"
)

// Command types
const (
	// Process management
	CmdListProcesses = "list_processes"
	CmdGetProcess    = "get_process"
	CmdKillProcess   = "kill_process"

	// Service management
	CmdListServices   = "list_services"
	CmdGetService     = "get_service"
	CmdStartService   = "start_service"
	CmdStopService    = "stop_service"
	CmdRestartService = "restart_service"

	// Event logs (Windows)
	CmdEventLogsList  = "event_logs_list"
	CmdEventLogsQuery = "event_logs_query"
	CmdEventLogGet    = "event_log_get"

	// Scheduled tasks (Windows)
	CmdTasksList   = "tasks_list"
	CmdTaskGet     = "task_get"
	CmdTaskRun     = "task_run"
	CmdTaskEnable  = "task_enable"
	CmdTaskDisable = "task_disable"

	// Registry (Windows)
	CmdRegistryKeys   = "registry_keys"
	CmdRegistryValues = "registry_values"
	CmdRegistryGet    = "registry_get"
	CmdRegistrySet    = "registry_set"
	CmdRegistryDelete = "registry_delete"

	// System
	CmdReboot   = "reboot"
	CmdShutdown = "shutdown"
	CmdLock     = "lock"

	// Software inventory
	CmdCollectSoftware = "collect_software"

	// File transfer
	CmdFileTransfer   = "file_transfer"
	CmdCancelTransfer = "cancel_transfer"

	// Remote desktop (WebRTC - legacy)
	CmdStartDesktop = "start_desktop"
	CmdStopDesktop  = "stop_desktop"

	// Remote desktop (WebSocket streaming)
	CmdDesktopStreamStart = "desktop_stream_start"
	CmdDesktopStreamStop  = "desktop_stream_stop"
	CmdDesktopInput       = "desktop_input"
	CmdDesktopConfig      = "desktop_config"

	// Terminal commands
	CmdTerminalStart  = "terminal_start"
	CmdTerminalData   = "terminal_data"
	CmdTerminalResize = "terminal_resize"
	CmdTerminalStop   = "terminal_stop"

	// Script execution
	CmdScript    = "script"
	CmdRunScript = "run_script"

	// Patching
	CmdPatchScan       = "patch_scan"
	CmdInstallPatches  = "install_patches"
	CmdRollbackPatches = "rollback_patches"

	// Security
	CmdSecurityCollectStatus    = "security_collect_status"
	CmdSecurityScan             = "security_scan"
	CmdSecurityThreatQuarantine = "security_threat_quarantine"
	CmdSecurityThreatRemove     = "security_threat_remove"
	CmdSecurityThreatRestore    = "security_threat_restore"

	// File operations
	CmdFileList   = "file_list"
	CmdFileRead   = "file_read"
	CmdFileWrite  = "file_write"
	CmdFileDelete = "file_delete"
	CmdFileMkdir  = "file_mkdir"
	CmdFileRename = "file_rename"

	// Network discovery
	CmdNetworkDiscovery = "network_discovery"

	// SNMP polling
	CmdSnmpPoll = "snmp_poll"

	// Script management (executor)
	CmdScriptCancel      = "script_cancel"
	CmdScriptListRunning = "script_list_running"

	// Backup management
	CmdBackupRun  = "backup_run"
	CmdBackupList = "backup_list"
	CmdBackupStop = "backup_stop"
)

// CommandResult represents the result of a command execution
type CommandResult struct {
	Status     string `json:"status"` // completed, failed, timeout
	ExitCode   int    `json:"exitCode,omitempty"`
	Stdout     string `json:"stdout,omitempty"`
	Stderr     string `json:"stderr,omitempty"`
	Error      string `json:"error,omitempty"`
	DurationMs int64  `json:"durationMs,omitempty"`
}

// NewSuccessResult creates a successful command result with data
func NewSuccessResult(data interface{}, durationMs int64) CommandResult {
	jsonData, err := json.Marshal(data)
	if err != nil {
		return CommandResult{
			Status:     "failed",
			ExitCode:   1,
			Error:      fmt.Sprintf("failed to marshal result: %v", err),
			DurationMs: durationMs,
		}
	}
	return CommandResult{
		Status:     "completed",
		ExitCode:   0,
		Stdout:     string(jsonData),
		DurationMs: durationMs,
	}
}

// NewErrorResult creates a failed command result
func NewErrorResult(err error, durationMs int64) CommandResult {
	return CommandResult{
		Status:     "failed",
		ExitCode:   1,
		Error:      err.Error(),
		DurationMs: durationMs,
	}
}

// Process information types
type ProcessInfo struct {
	PID         int32   `json:"pid"`
	Name        string  `json:"name"`
	User        string  `json:"user"`
	CPUPercent  float64 `json:"cpuPercent"`
	MemoryMB    float64 `json:"memoryMb"`
	Status      string  `json:"status"`
	CommandLine string  `json:"commandLine,omitempty"`
	ParentPID   int32   `json:"parentPid,omitempty"`
	Threads     int32   `json:"threads,omitempty"`
	CreateTime  int64   `json:"createTime,omitempty"`
}

type ProcessListResponse struct {
	Processes  []ProcessInfo `json:"processes"`
	Total      int           `json:"total"`
	Page       int           `json:"page"`
	Limit      int           `json:"limit"`
	TotalPages int           `json:"totalPages"`
}

// Service information types
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`      // Running, Stopped, Paused, etc.
	StartupType string `json:"startupType"` // Automatic, Manual, Disabled
	Account     string `json:"account,omitempty"`
	Path        string `json:"path,omitempty"`
	Description string `json:"description,omitempty"`
}

type ServiceListResponse struct {
	Services   []ServiceInfo `json:"services"`
	Total      int           `json:"total"`
	Page       int           `json:"page"`
	Limit      int           `json:"limit"`
	TotalPages int           `json:"totalPages"`
}

// Event log types
type EventLog struct {
	Name         string `json:"name"`
	DisplayName  string `json:"displayName"`
	RecordCount  int64  `json:"recordCount"`
	MaxSizeBytes int64  `json:"maxSizeBytes,omitempty"`
	Retention    string `json:"retention,omitempty"`
}

type EventLogEntry struct {
	RecordID    int64     `json:"recordId"`
	LogName     string    `json:"logName"`
	Level       string    `json:"level"` // Information, Warning, Error, Critical
	TimeCreated time.Time `json:"timeCreated"`
	Source      string    `json:"source"`
	EventID     int       `json:"eventId"`
	Message     string    `json:"message"`
	Computer    string    `json:"computer,omitempty"`
	UserID      string    `json:"userId,omitempty"`
}

type EventLogListResponse struct {
	Logs []EventLog `json:"logs"`
}

type EventLogQueryResponse struct {
	Events     []EventLogEntry `json:"events"`
	Total      int             `json:"total"`
	Page       int             `json:"page"`
	Limit      int             `json:"limit"`
	TotalPages int             `json:"totalPages"`
}

// Scheduled task types
type ScheduledTask struct {
	Name        string   `json:"name"`
	Path        string   `json:"path"`
	Folder      string   `json:"folder"`
	Status      string   `json:"status"` // ready, running, disabled
	LastRun     string   `json:"lastRun,omitempty"`
	NextRun     string   `json:"nextRun,omitempty"`
	LastResult  int      `json:"lastResult,omitempty"`
	Triggers    []string `json:"triggers,omitempty"`
	Author      string   `json:"author,omitempty"`
	Description string   `json:"description,omitempty"`
}

type TaskListResponse struct {
	Tasks      []ScheduledTask `json:"tasks"`
	Total      int             `json:"total"`
	Page       int             `json:"page"`
	Limit      int             `json:"limit"`
	TotalPages int             `json:"totalPages"`
}

// Registry types
type RegistryKey struct {
	Name         string `json:"name"`
	Path         string `json:"path"`
	SubKeyCount  int    `json:"subKeyCount"`
	ValueCount   int    `json:"valueCount"`
	LastModified string `json:"lastModified,omitempty"`
}

type RegistryValue struct {
	Name string `json:"name"`
	Type string `json:"type"` // REG_SZ, REG_DWORD, REG_BINARY, etc.
	Data string `json:"data"`
}

type RegistryKeysResponse struct {
	Keys []RegistryKey `json:"keys"`
	Path string        `json:"path"`
	Hive string        `json:"hive"`
}

type RegistryValuesResponse struct {
	Values []RegistryValue `json:"values"`
	Path   string          `json:"path"`
	Hive   string          `json:"hive"`
}

// FileEntry represents a file or directory in file listing responses
type FileEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Type        string `json:"type"` // "file" or "directory"
	Size        int64  `json:"size,omitempty"`
	Modified    string `json:"modified,omitempty"`
	Permissions string `json:"permissions,omitempty"`
}

// FileListResponse represents the response for file listing
type FileListResponse struct {
	Path    string      `json:"path"`
	Entries []FileEntry `json:"entries"`
}

// Payload helpers
func GetPayloadString(payload map[string]any, key string, defaultVal string) string {
	if v, ok := payload[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return defaultVal
}

func GetPayloadInt(payload map[string]any, key string, defaultVal int) int {
	if v, ok := payload[key]; ok {
		switch n := v.(type) {
		case int:
			return n
		case int64:
			return int(n)
		case float64:
			return int(n)
		}
	}
	return defaultVal
}

func GetPayloadBool(payload map[string]any, key string, defaultVal bool) bool {
	if v, ok := payload[key]; ok {
		if b, ok := v.(bool); ok {
			return b
		}
	}
	return defaultVal
}

func GetPayloadStringSlice(payload map[string]any, key string) []string {
	raw, ok := payload[key]
	if !ok {
		return nil
	}
	slice, ok := raw.([]interface{})
	if !ok {
		return nil
	}
	result := make([]string, 0, len(slice))
	for _, v := range slice {
		if s, ok := v.(string); ok {
			result = append(result, s)
		}
	}
	return result
}
