package tools

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
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
	CmdTaskHistory = "task_history"

	// Registry (Windows)
	CmdRegistryKeys      = "registry_keys"
	CmdRegistryValues    = "registry_values"
	CmdRegistryGet       = "registry_get"
	CmdRegistrySet       = "registry_set"
	CmdRegistryDelete    = "registry_delete"
	CmdRegistryKeyCreate = "registry_key_create"
	CmdRegistryKeyDelete = "registry_key_delete"

	// System
	CmdReboot         = "reboot"
	CmdShutdown       = "shutdown"
	CmdLock           = "lock"
	CmdRebootSafeMode = "reboot_safe_mode"
	CmdWakeOnLan      = "wake_on_lan"
	// On-demand re-run of all inventory collectors. Triggers the same set of
	// send*Inventory submissions the heartbeat fires periodically, so the API
	// sees fresh hardware/software/network/etc. without waiting for the next
	// scheduled cycle.
	CmdRefreshInventory = "refresh_inventory"

	// Software inventory
	CmdCollectSoftware   = "collect_software"
	CmdSoftwareUninstall = "software_uninstall"
	CmdSoftwareInstall   = "software_install"
	CmdSoftwareUpdate    = "software_update"

	// Opt-in Homebrew bootstrap (macOS) — installs Homebrew itself from a
	// pinned, checksum-verified copy of the official installer, run as the
	// active console user. Never implicit: only an explicit operator action
	// sends this.
	CmdHomebrewBootstrap = "homebrew_bootstrap"

	// Boot performance
	CmdCollectBootPerformance    = "collect_boot_performance"
	CmdManageStartupItem         = "manage_startup_item"
	CmdCollectReliabilityMetrics = "collect_reliability_metrics"

	// Audit policy compliance
	CmdCollectAuditPolicy       = "collect_audit_policy"
	CmdApplyAuditPolicyBaseline = "apply_audit_policy_baseline"

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
	CmdDownloadPatches = "download_patches"

	// Reboot management
	CmdScheduleReboot  = "schedule_reboot"
	CmdCancelReboot    = "cancel_reboot"
	CmdGetRebootStatus = "get_reboot_status"

	// Security
	CmdSecurityCollectStatus    = "security_collect_status"
	CmdSecurityScan             = "security_scan"
	CmdSecurityThreatQuarantine = "security_threat_quarantine"
	CmdSecurityThreatRemove     = "security_threat_remove"
	CmdSecurityThreatRestore    = "security_threat_restore"
	CmdSensitiveDataScan        = "sensitive_data_scan"
	CmdPeripheralPolicySyncV2   = "peripheral_policy_sync_v2"
	CmdAgentRollbackV1          = "agent_rollback_v1"
	CmdEncryptionCollectKeys    = "encryption_collect_keys"
	CmdEncryptionRotateKey      = "encryption_rotate_key"
	CmdEncryptFile              = "encrypt_file"
	CmdSecureDeleteFile         = "secure_delete_file"
	CmdQuarantineFile           = "quarantine_file"

	// File operations
	CmdFileList           = "file_list"
	CmdFileRead           = "file_read"
	CmdFileWrite          = "file_write"
	CmdFileDelete         = "file_delete"
	CmdFileMkdir          = "file_mkdir"
	CmdFileRename         = "file_rename"
	CmdFileCopy           = "file_copy"
	CmdFileTrashList      = "file_trash_list"
	CmdFileTrashRestore   = "file_trash_restore"
	CmdFileTrashPurge     = "file_trash_purge"
	CmdFilesystemAnalysis = "filesystem_analysis"
	CmdFileListDrives     = "file_list_drives"

	// Network discovery
	CmdNetworkDiscovery = "network_discovery"

	// SNMP polling
	CmdSnmpPoll = "snmp_poll"

	// Network monitoring
	CmdNetworkPing      = "network_ping"
	CmdNetworkTcpCheck  = "network_tcp_check"
	CmdNetworkHttpCheck = "network_http_check"
	CmdNetworkDnsCheck  = "network_dns_check"

	// Script management (executor)
	CmdScriptCancel      = "script_cancel"
	CmdScriptListRunning = "script_list_running"

	// Backup management
	CmdBackupRun         = "backup_run"
	CmdBackupList        = "backup_list"
	CmdBackupStop        = "backup_stop"
	CmdBackupRestore     = "backup_restore"
	CmdBackupVerify      = "backup_verify"
	CmdBackupTestRestore = "backup_test_restore"
	CmdBackupCleanup     = "backup_cleanup"

	// VSS backup management
	CmdVSSStatus     = "vss_status"
	CmdVSSWriterList = "vss_writer_list"

	// MSSQL backup management
	CmdMSSQLDiscover = "mssql_discover"
	CmdMSSQLBackup   = "mssql_backup"
	CmdMSSQLRestore  = "mssql_restore"
	CmdMSSQLVerify   = "mssql_verify"

	// System state & bare metal recovery
	CmdSystemStateCollect  = "system_state_collect"
	CmdHardwareProfile     = "hardware_profile"
	CmdVMRestoreFromBackup = "vm_restore_from_backup"
	CmdVMRestoreEstimate   = "vm_restore_estimate"
	CmdBMRRecover          = "bmr_recover"

	// Log shipping
	CmdSetLogLevel = "set_log_level"

	// Runtime diagnostics — on-demand pprof capture (#2389). No listening
	// socket: profiles are captured in-process and returned in the command
	// result, so nothing is reachable off-box.
	CmdCapturePprof = "capture_pprof"

	// Dev push (fast dev binary update)
	// Auto-update management
	CmdSetAutoUpdate = "set_auto_update"

	CmdDevUpdate = "dev_update"

	// Screenshot (AI Vision)
	CmdTakeScreenshot = "take_screenshot"

	// Computer control (AI Computer Use)
	CmdComputerAction = "computer_action"

	// Session management
	CmdListSessions = "list_sessions"

	// CIS benchmark compliance
	CmdCisBenchmark        = "cis_benchmark"
	CmdApplyCisRemediation = "apply_cis_remediation"

	// Peripheral control
	CmdPeripheralPolicySync = "peripheral_policy_sync"

	// Self-uninstall (remote wipe)
	CmdSelfUninstall = "self_uninstall"

	// Quick Support session teardown. Only an ephemeral support-mode client
	// acts on this; a permanently-installed agent refuses it (see
	// handleSupportEnd) so a forged or misrouted command cannot destroy a
	// real install.
	CmdSupportEnd = "support_end"

	// Hyper-V VM backup management
	CmdHypervDiscover   = "hyperv_discover"
	CmdHypervBackup     = "hyperv_backup"
	CmdHypervRestore    = "hyperv_restore"
	CmdHypervCheckpoint = "hyperv_checkpoint"
	CmdHypervVMState    = "hyperv_vm_state"

	// Incident response
	CmdCollectEvidence    = "collect_evidence"
	CmdExecuteContainment = "execute_containment"

	// TCP tunnel relay (VNC + network proxy)
	CmdTunnelOpen  = "tunnel_open"
	CmdTunnelData  = "tunnel_data"
	CmdTunnelClose = "tunnel_close"

	// One-shot HTTP proxy request (network proxy)
	CmdHttpRequest = "http_request"

	// PAM Track 5: actuate an approved UAC elevation by typing the
	// dormant-admin credentials into consent.exe on the secure desktop.
	// Server-pushed only; handled by internal/pamactuator on Windows and
	// a no-op stub on other platforms.
	CmdActuateElevation = "actuate_elevation"
	CmdPamApplyV2       = "pam_apply_v2"
	CmdPamCleanupV2     = "pam_cleanup_v2"
)

// CommandResult represents the result of a command execution
type CommandResult struct {
	Status string `json:"status"` // completed, failed, timeout
	// ExitCode is deliberately NOT omitempty (matching websocket.CommandResult):
	// the server persists `result.exitCode ?? null`, so omitting the zero value
	// would store NULL exit_code for every successful (exit-0) run (#2474).
	// Failure paths that never spawn a process must set a synthetic nonzero
	// exit code (NewErrorResult uses 1) so `exit_code = 0` always means "a
	// process ran and exited cleanly".
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout,omitempty"`
	Stderr   string `json:"stderr,omitempty"`
	Error    string `json:"error,omitempty"`
	// Result carries structured output for the HTTP command-result transport.
	// Most handlers leave it nil; WebSocket conversion independently reparses
	// JSON stdout to avoid duplicating large generic results on that wire.
	Result     any   `json:"result,omitempty"`
	DurationMs int64 `json:"durationMs,omitempty"`
	// RFC3339Nano timestamp captured by the agent at the moment the command's
	// primary work began. Set by command handlers that care about the server-
	// side reconstruction (e.g. software_install). Empty when not applicable.
	StartedAt string `json:"startedAt,omitempty"`
}

// NewSuccessResult creates a successful command result with data
func NewSuccessResult(data any, durationMs int64) CommandResult {
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
	Truncated  bool          `json:"truncated,omitempty"`
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
	Truncated  bool          `json:"truncated,omitempty"`
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
	Logs      []EventLog `json:"logs"`
	Truncated bool       `json:"truncated,omitempty"`
}

type EventLogQueryResponse struct {
	Events     []EventLogEntry `json:"events"`
	Total      int             `json:"total"`
	Page       int             `json:"page"`
	Limit      int             `json:"limit"`
	TotalPages int             `json:"totalPages"`
	Truncated  bool            `json:"truncated,omitempty"`
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
	Truncated  bool            `json:"truncated,omitempty"`
}

type TaskHistoryEntry struct {
	ID         string `json:"id"`
	EventID    int    `json:"eventId"`
	Timestamp  string `json:"timestamp"`
	Level      string `json:"level"`
	Message    string `json:"message"`
	ResultCode *int   `json:"resultCode,omitempty"`
}

type TaskHistoryResponse struct {
	History   []TaskHistoryEntry `json:"history"`
	Path      string             `json:"path"`
	Total     int                `json:"total"`
	Truncated bool               `json:"truncated,omitempty"`
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
	Keys      []RegistryKey `json:"keys"`
	Path      string        `json:"path"`
	Hive      string        `json:"hive"`
	Truncated bool          `json:"truncated,omitempty"`
}

type RegistryValuesResponse struct {
	Values    []RegistryValue `json:"values"`
	Path      string          `json:"path"`
	Hive      string          `json:"hive"`
	Truncated bool            `json:"truncated,omitempty"`
}

// FileEntry represents a file or directory in file listing responses
type FileEntry struct {
	Name string `json:"name"`
	// Path always names the entry itself. For a macOS Finder alias that means
	// the alias file, not its target, so rename/delete/move act on the alias.
	Path string `json:"path"`
	// Type is "file" or "directory". A resolved macOS Finder alias reports the
	// kind of its *target*, so existing clients navigate into a folder alias
	// and download through a file alias without needing to know about aliases.
	Type string `json:"type"`
	// Size, Modified and Permissions always describe the entry at Path — for an
	// alias that is the small bookmark file, not its target, so that a delete
	// confirmation quotes what will actually be removed.
	Size        int64  `json:"size,omitempty"`
	Modified    string `json:"modified,omitempty"`
	Permissions string `json:"permissions,omitempty"`
	// IsAlias marks a macOS Finder alias that was resolved successfully, and
	// AliasTarget carries the absolute path it resolved to. Both are omitted for
	// ordinary entries and for aliases that could not be resolved (which stay
	// indistinguishable from plain files, as before).
	IsAlias     bool   `json:"isAlias,omitempty"`
	AliasTarget string `json:"aliasTarget,omitempty"`
}

// FileListResponse represents the response for file listing
type FileListResponse struct {
	Path      string      `json:"path"`
	Entries   []FileEntry `json:"entries"`
	Limit     int         `json:"limit"`
	Truncated bool        `json:"truncated,omitempty"`
}

// TrashMetadata stores info about a trashed item for restore/audit purposes.
type TrashMetadata struct {
	OriginalPath string `json:"originalPath"`
	TrashID      string `json:"trashId"`
	DeletedAt    string `json:"deletedAt"`
	DeletedBy    string `json:"deletedBy,omitempty"`
	IsDirectory  bool   `json:"isDirectory"`
	SizeBytes    int64  `json:"sizeBytes"`
}

// TrashListResponse is the response for listing trash contents.
type TrashListResponse struct {
	Items     []TrashMetadata `json:"items"`
	Path      string          `json:"path"`
	Truncated bool            `json:"truncated,omitempty"`
}

// DriveInfo represents a logical drive (Windows) or mount point (Unix).
type DriveInfo struct {
	Letter     string `json:"letter,omitempty"`     // e.g. "C:" (Windows only)
	MountPoint string `json:"mountPoint"`           // e.g. "C:\\" or "/"
	Label      string `json:"label,omitempty"`      // volume label
	FileSystem string `json:"fileSystem,omitempty"` // e.g. "NTFS", "ext4"
	TotalBytes int64  `json:"totalBytes"`
	FreeBytes  int64  `json:"freeBytes"`
	DriveType  string `json:"driveType,omitempty"` // "fixed", "removable", "network", "cdrom", "unknown"
}

// DriveListResponse is the response for listing drives/mount points.
type DriveListResponse struct {
	Drives    []DriveInfo `json:"drives"`
	Truncated bool        `json:"truncated,omitempty"`
}

// FilesystemLargestFile captures one large file candidate.
type FilesystemLargestFile struct {
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
	Owner      string `json:"owner,omitempty"`
}

// FilesystemLargestDirectory captures one large directory candidate.
type FilesystemLargestDirectory struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	FileCount int64  `json:"fileCount"`
	Estimated bool   `json:"estimated,omitempty"`
}

// FilesystemAccumulation captures grouped byte totals for cleanup categories.
type FilesystemAccumulation struct {
	Category string `json:"category"`
	Bytes    int64  `json:"bytes"`
}

// FilesystemOldDownload captures a stale download candidate.
type FilesystemOldDownload struct {
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
	Owner      string `json:"owner,omitempty"`
}

// FilesystemUnrotatedLog captures large log files that look unrotated.
type FilesystemUnrotatedLog struct {
	Path       string `json:"path"`
	SizeBytes  int64  `json:"sizeBytes"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
}

// FilesystemTrashUsage captures trash/recycle bin usage.
type FilesystemTrashUsage struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

// FilesystemDuplicateCandidate captures a duplicate group candidate.
type FilesystemDuplicateCandidate struct {
	Key       string   `json:"key"`
	SizeBytes int64    `json:"sizeBytes"`
	Count     int      `json:"count"`
	Paths     []string `json:"paths"`
}

// FilesystemCleanupCandidate captures a safe cleanup candidate.
type FilesystemCleanupCandidate struct {
	Path       string `json:"path"`
	Category   string `json:"category"`
	SizeBytes  int64  `json:"sizeBytes"`
	Safe       bool   `json:"safe"`
	Reason     string `json:"reason,omitempty"`
	ModifiedAt string `json:"modifiedAt,omitempty"`
}

// FilesystemScanError captures per-path scan errors.
type FilesystemScanError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// FilesystemAnalysisSummary captures high-level scan stats.
type FilesystemAnalysisSummary struct {
	FilesScanned          int64 `json:"filesScanned"`
	DirsScanned           int64 `json:"dirsScanned"`
	BytesScanned          int64 `json:"bytesScanned"`
	MaxDepthReached       int   `json:"maxDepthReached"`
	PermissionDeniedCount int64 `json:"permissionDeniedCount"`
}

// FilesystemAnalysisResponse captures the full analysis payload.
type FilesystemAnalysisResponse struct {
	Path                string                         `json:"path"`
	ScanMode            string                         `json:"scanMode,omitempty"`
	StartedAt           string                         `json:"startedAt"`
	CompletedAt         string                         `json:"completedAt"`
	DurationMs          int64                          `json:"durationMs"`
	Partial             bool                           `json:"partial"`
	Reason              string                         `json:"reason,omitempty"`
	Checkpoint          map[string]any                 `json:"checkpoint,omitempty"`
	Summary             FilesystemAnalysisSummary      `json:"summary"`
	TopLargestFiles     []FilesystemLargestFile        `json:"topLargestFiles"`
	TopLargestDirs      []FilesystemLargestDirectory   `json:"topLargestDirectories"`
	TempAccumulation    []FilesystemAccumulation       `json:"tempAccumulation"`
	OldDownloads        []FilesystemOldDownload        `json:"oldDownloads"`
	UnrotatedLogs       []FilesystemUnrotatedLog       `json:"unrotatedLogs"`
	TrashUsage          []FilesystemTrashUsage         `json:"trashUsage"`
	DuplicateCandidates []FilesystemDuplicateCandidate `json:"duplicateCandidates"`
	CleanupCandidates   []FilesystemCleanupCandidate   `json:"cleanupCandidates"`
	Errors              []FilesystemScanError          `json:"errors"`
}

// ScreenshotResponse represents the result of a screenshot capture.
// When the image is scaled down (e.g., from 2560x1440 to 1920x1080),
// Width/Height reflect the IMAGE dimensions while ScreenWidth/ScreenHeight
// reflect the actual screen resolution. Mouse coordinates should be in
// screen space (ScreenWidth x ScreenHeight), not image space.
type ScreenshotResponse struct {
	ImageBase64  string `json:"imageBase64"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	ScreenWidth  int    `json:"screenWidth,omitempty"`  // Actual screen resolution
	ScreenHeight int    `json:"screenHeight,omitempty"` // Use for mouse coordinate space
	Format       string `json:"format"`
	SizeBytes    int    `json:"sizeBytes"`
	Monitor      int    `json:"monitor"`
	CapturedAt   string `json:"capturedAt"`
}

// ComputerActionResponse represents the result of a computer action
type ComputerActionResponse struct {
	ActionExecuted  string              `json:"actionExecuted"`
	Screenshot      *ScreenshotResponse `json:"screenshot,omitempty"`
	ScreenshotError string              `json:"screenshotError,omitempty"`
	Error           string              `json:"error,omitempty"`
}

// RequirePayloadString extracts a required string field from the payload.
// Returns an error result if the field is missing or empty.
func RequirePayloadString(payload map[string]any, key string) (string, *CommandResult) {
	val := GetPayloadString(payload, key, "")
	if val == "" {
		result := CommandResult{
			Status: "failed",
			Error:  fmt.Sprintf("missing required field: %s", key),
		}
		return "", &result
	}
	return val, nil
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

// ParsePayloadInt reads an integer field from a command payload, distinguishing
// an ABSENT key from a MALFORMED value — the distinction GetPayloadInt cannot
// express, because it reports both as defaultVal.
//
// Absent (returns defaultVal, nil):
//   - the key is missing, or present as JSON null
//
// Accepted:
//   - int, int64, and float64 — the types encoding/json and hand-built payloads
//     actually produce
//   - json.Number and numeric strings ("15"), via a strict base-10 parse
//
// Rejected with an error:
//   - non-integral, NaN, infinite, or out-of-int-range floats (15.5, 1e300)
//   - booleans, objects, arrays, and unparseable or empty strings ("soon", "")
//
// "The caller did not specify this field" is a meaningful statement that a
// default can stand in for. "The caller specified garbage" is not. Handlers for
// destructive commands MUST use this rather than GetPayloadInt, so a malformed
// reboot delay fails the command instead of collapsing onto 0 — which for
// reboot/shutdown means "act immediately" (issue #3373).
func ParsePayloadInt(payload map[string]any, key string, defaultVal int) (int, error) {
	raw, ok := payload[key]
	if !ok || raw == nil {
		return defaultVal, nil
	}

	switch n := raw.(type) {
	case int:
		return n, nil
	case int64:
		return intFromInt64(key, n)
	case float64:
		return intFromFloat64(key, n)
	case json.Number:
		return intFromNumericString(key, n.String())
	case string:
		return intFromNumericString(key, n)
	default:
		return 0, fmt.Errorf("%s must be a number, got %T", key, raw)
	}
}

// GetPayloadInt reads an integer field, falling back to defaultVal when the key
// is absent OR malformed.
//
// It accepts exactly what ParsePayloadInt accepts (numeric strings included);
// the only difference is that a malformed value is swallowed instead of
// reported. Prefer ParsePayloadInt wherever a silently wrong value has
// consequences.
func GetPayloadInt(payload map[string]any, key string, defaultVal int) int {
	n, err := ParsePayloadInt(payload, key, defaultVal)
	if err != nil {
		return defaultVal
	}
	return n
}

// intFromInt64 narrows to int via a round-trip check, which is exact on both
// 32- and 64-bit builds without needing platform-specific bounds constants.
func intFromInt64(key string, n int64) (int, error) {
	if int64(int(n)) != n {
		return 0, fmt.Errorf("%s value %d is out of range", key, n)
	}
	return int(n), nil
}

func intFromFloat64(key string, f float64) (int, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return 0, fmt.Errorf("%s must be a whole number, got %v", key, f)
	}
	// float64 spans far beyond int on every platform; reject out-of-range
	// values rather than letting the conversion produce an
	// implementation-defined result. -float64(math.MinInt) is exactly 2^63
	// (2^31 on 32-bit builds), i.e. one past the largest valid int.
	if f < float64(math.MinInt) || f >= -float64(math.MinInt) {
		return 0, fmt.Errorf("%s value %v is out of range", key, f)
	}
	return int(f), nil
}

func intFromNumericString(key, s string) (int, error) {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return 0, fmt.Errorf("%s must be a number, got an empty string", key)
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil {
		return 0, fmt.Errorf("%s must be a number, got %q", key, s)
	}
	return n, nil
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
	slice, ok := raw.([]any)
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
