package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/discovery"
	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/filetransfer"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/breeze-rmm/agent/internal/terminal"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workerpool"
)

var log = logging.L("heartbeat")

type HeartbeatPayload struct {
	Metrics       *collectors.SystemMetrics `json:"metrics"`
	Status        string                    `json:"status"`
	AgentVersion  string                    `json:"agentVersion"`
	PendingReboot bool                      `json:"pendingReboot,omitempty"`
	LastUser      string                    `json:"lastUser,omitempty"`
	HealthStatus  map[string]any            `json:"healthStatus,omitempty"`
}

type HeartbeatResponse struct {
	Commands     []Command      `json:"commands"`
	ConfigUpdate map[string]any `json:"configUpdate,omitempty"`
	UpgradeTo    string         `json:"upgradeTo,omitempty"`
}

type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type Heartbeat struct {
	config              *config.Config
	client              *http.Client
	stopChan            chan struct{}
	metricsCol          *collectors.MetricsCollector
	hardwareCol         *collectors.HardwareCollector
	softwareCol         *collectors.SoftwareCollector
	inventoryCol        *collectors.InventoryCollector
	patchCol            *collectors.PatchCollector
	patchMgr            *patching.PatchManager
	connectionsCol      *collectors.ConnectionsCollector
	eventLogCol         *collectors.EventLogCollector
	agentVersion        string
	fileTransferMgr     *filetransfer.Manager
	desktopMgr          *desktop.SessionManager
	wsDesktopMgr        *desktop.WsSessionManager
	terminalMgr         *terminal.Manager
	executor            *executor.Executor
	backupMgr           *backup.BackupManager
	securityScanner     *security.SecurityScanner
	wsClient            *websocket.Client
	mu                  sync.Mutex
	lastInventoryUpdate time.Time
	lastEventLogUpdate  time.Time
	lastSecurityUpdate  time.Time

	// Resilience & observability
	pool       *workerpool.Pool
	healthMon  *health.Monitor
	auditLog   *audit.Logger
	accepting  atomic.Bool
	wg         sync.WaitGroup
	retryCfg   httputil.RetryConfig
	stopOnce   sync.Once
}

func New(cfg *config.Config) *Heartbeat {
	return NewWithVersion(cfg, "0.1.0")
}

func NewWithVersion(cfg *config.Config, version string) *Heartbeat {
	ftConfig := &filetransfer.Config{
		ServerURL: cfg.ServerURL,
		AuthToken: cfg.AuthToken,
		AgentID:   cfg.AgentID,
	}

	h := &Heartbeat{
		config:          cfg,
		client:          &http.Client{Timeout: 30 * time.Second},
		stopChan:        make(chan struct{}),
		metricsCol:      collectors.NewMetricsCollector(),
		hardwareCol:     collectors.NewHardwareCollector(),
		softwareCol:     collectors.NewSoftwareCollector(),
		inventoryCol:    collectors.NewInventoryCollector(),
		patchCol:        collectors.NewPatchCollector(),
		patchMgr:        patching.NewDefaultManager(),
		connectionsCol:  collectors.NewConnectionsCollector(),
		eventLogCol:     collectors.NewEventLogCollector(),
		agentVersion:    version,
		executor:        executor.New(cfg),
		fileTransferMgr: filetransfer.NewManager(ftConfig),
		desktopMgr:      desktop.NewSessionManager(),
		wsDesktopMgr:    desktop.NewWsSessionManager(),
		terminalMgr:     terminal.NewManager(),
		securityScanner: &security.SecurityScanner{Config: cfg},
		pool:            workerpool.New(cfg.MaxConcurrentCommands, cfg.CommandQueueSize),
		healthMon:       health.NewMonitor(),
		retryCfg:        httputil.DefaultRetryConfig(),
	}
	h.accepting.Store(true)

	// Initialize audit logger if enabled
	if cfg.AuditEnabled {
		auditLogger, err := audit.NewLogger(cfg)
		if err != nil {
			log.Error("failed to start audit logger", "error", err)
		} else {
			h.auditLog = auditLogger
		}
	}

	// Initialize backup manager if enabled
	if cfg.BackupEnabled && len(cfg.BackupPaths) > 0 {
		var backupProvider providers.BackupProvider
		switch cfg.BackupProvider {
		case "s3":
			backupProvider = providers.NewS3Provider(cfg.BackupS3Bucket, cfg.BackupS3Region, "", "", "")
		default:
			localPath := cfg.BackupLocalPath
			if localPath == "" {
				localPath = config.GetDataDir() + "/backups"
			}
			backupProvider = providers.NewLocalProvider(localPath)
		}
		schedule, parseErr := time.ParseDuration(cfg.BackupSchedule)
		if parseErr != nil && cfg.BackupSchedule != "" {
			log.Warn("invalid backup schedule, using default 24h",
				"schedule", cfg.BackupSchedule, "error", parseErr)
		}
		if schedule <= 0 {
			schedule = 24 * time.Hour
		}
		retention := cfg.BackupRetention
		if retention <= 0 {
			retention = 7
		}
		h.backupMgr = backup.NewBackupManager(backup.BackupConfig{
			Provider:  backupProvider,
			Paths:     cfg.BackupPaths,
			Schedule:  schedule,
			Retention: retention,
		})
	}

	return h
}

// SetWebSocketClient sets the WebSocket client for terminal output streaming
func (h *Heartbeat) SetWebSocketClient(ws *websocket.Client) {
	h.wsClient = ws
}

// AuditLog returns the audit logger for use by other components.
func (h *Heartbeat) AuditLog() *audit.Logger {
	return h.auditLog
}

// HealthMonitor returns the health monitor for use by other components.
func (h *Heartbeat) HealthMonitor() *health.Monitor {
	return h.healthMon
}

// sendTerminalOutput streams terminal output via WebSocket
func (h *Heartbeat) sendTerminalOutput(sessionId string, data []byte) {
	if h.wsClient != nil {
		if err := h.wsClient.SendTerminalOutput(sessionId, data); err != nil {
			log.Warn("terminal output dropped", "sessionId", sessionId, "error", err)
		}
	}
}

func (h *Heartbeat) Start() {
	// Start backup scheduler if configured
	if h.backupMgr != nil {
		if err := h.backupMgr.Start(); err != nil {
			log.Error("failed to start backup manager", "error", err)
		}
	}

	// Jitter: random delay before first heartbeat to avoid thundering herd
	// after mass restart of agents
	interval := time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second
	jitter := time.Duration(rand.Int64N(int64(interval)))
	log.Info("initial heartbeat jitter", "delay", jitter)
	select {
	case <-time.After(jitter):
	case <-h.stopChan:
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Send initial heartbeat after jitter
	h.sendHeartbeat()

	// Send initial inventory in background
	go h.sendInventory()

	for {
		select {
		case <-ticker.C:
			h.sendHeartbeat()
			// Send inventory every 15 minutes
			h.mu.Lock()
			shouldSendInventory := time.Since(h.lastInventoryUpdate) > 15*time.Minute
			if shouldSendInventory {
				h.lastInventoryUpdate = time.Now()
			}
			shouldSendEventLogs := time.Since(h.lastEventLogUpdate) > 5*time.Minute
			if shouldSendEventLogs {
				h.lastEventLogUpdate = time.Now()
			}
			shouldSendSecurity := time.Since(h.lastSecurityUpdate) > 5*time.Minute
			if shouldSendSecurity {
				h.lastSecurityUpdate = time.Now()
			}
			h.mu.Unlock()
			if shouldSendInventory {
				go h.sendInventory()
			}
			// Send event logs every 5 minutes
			if shouldSendEventLogs {
				go h.sendEventLogs()
			}
			// Send security status every 5 minutes
			if shouldSendSecurity {
				go h.sendSecurityStatus()
			}
		case <-h.stopChan:
			return
		}
	}
}

// StopAcceptingCommands prevents new commands from being dispatched.
func (h *Heartbeat) StopAcceptingCommands() {
	h.accepting.Store(false)
	h.pool.StopAccepting()
}

// DrainAndWait waits for all in-flight commands to complete, respecting ctx deadline.
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
	log.Info("draining in-flight commands")
	h.pool.Drain(ctx)
	h.wg.Wait()
	log.Info("all commands drained")
}

func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() {
		if h.backupMgr != nil {
			h.backupMgr.Stop()
		}
		if h.auditLog != nil {
			h.auditLog.Log(audit.EventAgentStop, "", nil)
			h.auditLog.Close()
		}
		close(h.stopChan)
	})
}

// sendInventory collects and sends hardware, software, disk, network, connections, and patch inventory
func (h *Heartbeat) sendInventory() {
	go h.sendHardwareInventory()
	go h.sendSoftwareInventory()
	go h.sendDiskInventory()
	go h.sendNetworkInventory()
	go h.sendConnectionsInventory()
	go h.sendPatchInventory()
	go h.sendSecurityStatus()
}

// sendInventoryData marshals the payload and sends it to the given endpoint via PUT.
func (h *Heartbeat) sendInventoryData(endpoint string, payload interface{}, label string) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal inventory", "label", label, "error", err)
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/%s", h.config.ServerURL, h.config.AgentID, endpoint)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {"Bearer " + h.config.AuthToken},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.client, "PUT", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send inventory", "label", label, "error", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusOK {
		log.Debug("inventory sent", "label", label)
	} else {
		log.Warn("inventory send failed", "label", label, "status", resp.StatusCode)
	}
}

func (h *Heartbeat) sendHardwareInventory() {
	hw, err := h.hardwareCol.CollectHardware()
	if err != nil {
		log.Error("failed to collect hardware info", "error", err)
		return
	}
	h.sendInventoryData("hardware", hw, "hardware")
}

func (h *Heartbeat) sendSoftwareInventory() {
	software, err := h.softwareCol.Collect()
	if err != nil {
		log.Error("failed to collect software inventory", "error", err)
		return
	}

	items := make([]map[string]interface{}, len(software))
	for i, item := range software {
		items[i] = map[string]interface{}{
			"name":            item.Name,
			"version":         item.Version,
			"vendor":          item.Vendor,
			"installDate":     item.InstallDate,
			"installLocation": item.InstallLocation,
			"uninstallString": item.UninstallString,
		}
	}

	h.sendInventoryData("software", map[string]interface{}{"software": items}, fmt.Sprintf("software (%d items)", len(software)))
}

func (h *Heartbeat) sendDiskInventory() {
	disks, err := h.inventoryCol.CollectDisks()
	if err != nil {
		log.Error("failed to collect disk inventory", "error", err)
		return
	}

	h.sendInventoryData("disks", map[string]interface{}{"disks": disks}, fmt.Sprintf("disks (%d)", len(disks)))
}

func (h *Heartbeat) sendNetworkInventory() {
	adapters, err := h.inventoryCol.CollectNetworkAdapters()
	if err != nil {
		log.Error("failed to collect network inventory", "error", err)
		return
	}

	h.sendInventoryData("network", map[string]interface{}{"adapters": adapters}, fmt.Sprintf("network (%d adapters)", len(adapters)))
}

func (h *Heartbeat) sendPatchInventory() {
	pendingItems, installedItems, err := h.collectPatchInventory()
	if err != nil {
		log.Warn("patch inventory collection warning", "error", err)
	}

	if len(pendingItems) == 0 && len(installedItems) == 0 {
		log.Debug("no patches found")
		return
	}

	h.sendInventoryData("patches", map[string]interface{}{
		"patches":   pendingItems,
		"installed": installedItems,
	}, fmt.Sprintf("patches (%d pending, %d installed)", len(pendingItems), len(installedItems)))
}

func (h *Heartbeat) collectPatchInventory() ([]map[string]interface{}, []map[string]interface{}, error) {
	if h.patchMgr != nil && len(h.patchMgr.ProviderIDs()) > 0 {
		available, scanErr := h.patchMgr.Scan()
		installed, installedErr := h.patchMgr.GetInstalled()

		pendingItems := make([]map[string]interface{}, len(available))
		for i, patch := range available {
			pendingItems[i] = map[string]interface{}{
				"name":        patch.Title,
				"version":     patch.Version,
				"category":    h.mapPatchProviderCategory(patch.Provider),
				"severity":    "unknown",
				"description": patch.Description,
				"source":      h.mapPatchProviderSource(patch.Provider),
			}
		}

		installedItems := make([]map[string]interface{}, len(installed))
		for i, patch := range installed {
			installedItems[i] = map[string]interface{}{
				"name":        patch.Title,
				"version":     patch.Version,
				"category":    h.mapPatchProviderCategory(patch.Provider),
				"source":      h.mapPatchProviderSource(patch.Provider),
				"installedAt": "",
			}
		}

		if scanErr != nil && installedErr != nil {
			return pendingItems, installedItems, fmt.Errorf("patch scan failed: %v; installed scan failed: %v", scanErr, installedErr)
		}
		if scanErr != nil {
			return pendingItems, installedItems, scanErr
		}
		if installedErr != nil {
			return pendingItems, installedItems, installedErr
		}

		return pendingItems, installedItems, nil
	}

	return h.collectPatchInventoryFromCollectors()
}

func (h *Heartbeat) collectPatchInventoryFromCollectors() ([]map[string]interface{}, []map[string]interface{}, error) {
	patches, collectErr := h.patchCol.Collect()
	installedPatches, installedErr := h.patchCol.CollectInstalled(90 * 24 * time.Hour)

	pendingItems := make([]map[string]interface{}, len(patches))
	for i, patch := range patches {
		pendingItems[i] = map[string]interface{}{
			"name":            patch.Name,
			"version":         patch.Version,
			"currentVersion":  patch.CurrentVer,
			"kbNumber":        patch.KBNumber,
			"category":        patch.Category,
			"severity":        h.mapPatchSeverity(patch.Severity),
			"size":            patch.Size,
			"requiresRestart": patch.IsRestart,
			"releaseDate":     patch.ReleaseDate,
			"description":     patch.Description,
			"source":          h.mapPatchSource(patch.Source),
		}
	}

	installedItems := make([]map[string]interface{}, len(installedPatches))
	for i, patch := range installedPatches {
		installedItems[i] = map[string]interface{}{
			"name":        patch.Name,
			"version":     patch.Version,
			"category":    patch.Category,
			"source":      h.mapPatchSource(patch.Source),
			"installedAt": patch.InstalledAt,
		}
	}

	if collectErr != nil && installedErr != nil {
		return pendingItems, installedItems, fmt.Errorf("patch collect failed: %v; installed collect failed: %v", collectErr, installedErr)
	}
	if collectErr != nil {
		return pendingItems, installedItems, collectErr
	}
	if installedErr != nil {
		return pendingItems, installedItems, installedErr
	}

	return pendingItems, installedItems, nil
}

func (h *Heartbeat) mapPatchSource(source string) string {
	switch source {
	case "apple", "homebrew":
		return "apple"
	case "microsoft":
		return "microsoft"
	case "apt", "yum", "dnf":
		return "linux"
	default:
		return "custom"
	}
}

func (h *Heartbeat) mapPatchProviderSource(provider string) string {
	switch provider {
	case "windows-update":
		return "microsoft"
	case "apple-softwareupdate":
		return "apple"
	case "homebrew":
		return "third_party"
	case "chocolatey":
		return "third_party"
	case "apt", "yum":
		return "linux"
	default:
		return "custom"
	}
}

func (h *Heartbeat) mapPatchProviderCategory(provider string) string {
	switch provider {
	case "windows-update", "apple-softwareupdate":
		return "system"
	case "homebrew", "chocolatey":
		return "application"
	case "apt", "yum":
		return "system"
	default:
		return "application"
	}
}

func (h *Heartbeat) mapPatchSeverity(severity string) string {
	switch severity {
	case "critical", "important", "moderate", "low":
		return severity
	default:
		return "unknown"
	}
}

func (h *Heartbeat) sendConnectionsInventory() {
	connections, err := h.connectionsCol.Collect()
	if err != nil {
		log.Error("failed to collect connections", "error", err)
		return
	}

	if len(connections) == 0 {
		log.Debug("no active connections found")
		return
	}

	items := make([]map[string]interface{}, len(connections))
	for i, conn := range connections {
		items[i] = map[string]interface{}{
			"protocol":    conn.Protocol,
			"localAddr":   conn.LocalAddr,
			"localPort":   conn.LocalPort,
			"remoteAddr":  conn.RemoteAddr,
			"remotePort":  conn.RemotePort,
			"state":       conn.State,
			"pid":         conn.Pid,
			"processName": conn.ProcessName,
		}
	}

	h.sendInventoryData("connections", map[string]interface{}{"connections": items}, fmt.Sprintf("connections (%d active)", len(connections)))
}

func (h *Heartbeat) sendEventLogs() {
	events, err := h.eventLogCol.Collect()
	if err != nil {
		log.Error("failed to collect event logs", "error", err)
		return
	}

	if len(events) == 0 {
		return
	}

	h.sendInventoryData("eventlogs", map[string]interface{}{"events": events}, fmt.Sprintf("event logs (%d events)", len(events)))
}

func (h *Heartbeat) sendSecurityStatus() {
	status, err := security.CollectStatus(h.config)
	if err != nil {
		log.Warn("security status collection warning", "error", err)
	}

	h.sendInventoryData("security/status", status, "security status")
}

func (h *Heartbeat) sendHeartbeat() {
	metrics, err := h.metricsCol.Collect()
	if err != nil {
		log.Error("failed to collect metrics", "error", err)
		h.healthMon.Update("metrics", health.Degraded, err.Error())
		metrics = &collectors.SystemMetrics{}
	} else {
		h.healthMon.Update("metrics", health.Healthy, "")
	}

	status := "ok"
	if metrics.CPUPercent > 90 || metrics.RAMPercent > 90 || metrics.DiskPercent > 90 {
		status = "warning"
	}

	payload := HeartbeatPayload{
		Metrics:      metrics,
		Status:       status,
		AgentVersion: h.agentVersion,
		HealthStatus: h.healthMon.Summary(),
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal heartbeat", "error", err)
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", h.config.ServerURL, h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {"Bearer " + h.config.AuthToken},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.client, "POST", url, body, headers, h.retryCfg)
	if err != nil {
		log.Error("failed to send heartbeat", "error", err)
		h.healthMon.Update("heartbeat", health.Unhealthy, err.Error())
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Warn("heartbeat returned non-OK status", "status", resp.StatusCode)
		h.healthMon.Update("heartbeat", health.Degraded, fmt.Sprintf("status %d", resp.StatusCode))
		return
	}

	h.healthMon.Update("heartbeat", health.Healthy, "")

	var response HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		log.Error("failed to decode heartbeat response", "error", err)
		return
	}

	// Process any commands via worker pool
	for _, cmd := range response.Commands {
		if !h.accepting.Load() {
			log.Warn("rejecting command, agent shutting down", logging.KeyCommandID, cmd.ID)
			break
		}
		c := cmd // capture
		if !h.pool.Submit(func() { h.processCommand(c) }) {
			log.Warn("command rejected, worker pool full", logging.KeyCommandID, cmd.ID)
		}
	}

	// Handle upgrade if requested
	if response.UpgradeTo != "" && response.UpgradeTo != h.agentVersion {
		go h.handleUpgrade(response.UpgradeTo)
	}
}

func (h *Heartbeat) processCommand(cmd Command) {
	result := h.executeCommand(cmd)

	// Submit result back to API
	if err := h.submitCommandResult(cmd.ID, result); err != nil {
		log.Error("failed to submit command result", logging.KeyCommandID, cmd.ID, "error", err)
	}
}

func (h *Heartbeat) submitCommandResult(commandID string, result tools.CommandResult) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", h.config.ServerURL, h.config.AgentID, commandID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {"Bearer " + h.config.AuthToken},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.client, "POST", url, body, headers, h.retryCfg)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("submit result failed with status %d", resp.StatusCode)
	}

	log.Info("command completed", logging.KeyCommandID, commandID, "status", result.Status)
	return nil
}

// HandleCommand processes a command from WebSocket and returns a result
func (h *Heartbeat) HandleCommand(wsCmd websocket.Command) websocket.CommandResult {
	if !h.accepting.Load() {
		return websocket.CommandResult{
			CommandID: wsCmd.ID,
			Status:    "failed",
			Error:     "agent is shutting down",
		}
	}

	cmd := Command{
		ID:      wsCmd.ID,
		Type:    wsCmd.Type,
		Payload: wsCmd.Payload,
	}

	result := h.executeCommand(cmd)

	wsResult := websocket.CommandResult{
		CommandID: cmd.ID,
		Status:    result.Status,
	}

	if result.Error != "" {
		wsResult.Error = result.Error
	} else if result.Stdout != "" {
		var jsonResult any
		if err := json.Unmarshal([]byte(result.Stdout), &jsonResult); err == nil {
			wsResult.Result = jsonResult
		} else {
			wsResult.Result = result.Stdout
		}
	}

	if !isEphemeralCommand(cmd.Type) {
		go h.submitCommandResult(cmd.ID, result)
	}

	return wsResult
}

func isEphemeralCommand(cmdType string) bool {
	switch cmdType {
	case tools.CmdTerminalStart, tools.CmdTerminalData, tools.CmdTerminalResize, tools.CmdTerminalStop,
		tools.CmdDesktopStreamStart, tools.CmdDesktopStreamStop, tools.CmdDesktopInput, tools.CmdDesktopConfig:
		return true
	}
	return false
}

// executeCommand runs a command and returns the result
func (h *Heartbeat) executeCommand(cmd Command) tools.CommandResult {
	cmdLog := logging.WithCommand(log, cmd.ID, cmd.Type)
	cmdLog.Info("processing command")

	// Audit: command received
	if h.auditLog != nil {
		h.auditLog.Log(audit.EventCommandReceived, cmd.ID, map[string]any{
			"type": cmd.Type,
		})
	}

	// Privilege check (warn-only for now)
	if privilege.RequiresElevation(cmd.Type) && !privilege.IsRunningAsRoot() {
		cmdLog.Warn("command requires elevated privileges but agent is not running as root")
	}

	var result tools.CommandResult

	switch cmd.Type {
	// Process management
	case tools.CmdListProcesses:
		result = tools.ListProcesses(cmd.Payload)
	case tools.CmdGetProcess:
		result = tools.GetProcess(cmd.Payload)
	case tools.CmdKillProcess:
		result = tools.KillProcess(cmd.Payload)

	// Service management
	case tools.CmdListServices:
		result = tools.ListServices(cmd.Payload)
	case tools.CmdGetService:
		result = tools.GetService(cmd.Payload)
	case tools.CmdStartService:
		result = tools.StartService(cmd.Payload)
	case tools.CmdStopService:
		result = tools.StopService(cmd.Payload)
	case tools.CmdRestartService:
		result = tools.RestartService(cmd.Payload)

	// Event logs (Windows)
	case tools.CmdEventLogsList:
		result = tools.ListEventLogs(cmd.Payload)
	case tools.CmdEventLogsQuery:
		result = tools.QueryEventLogs(cmd.Payload)
	case tools.CmdEventLogGet:
		result = tools.GetEventLogEntry(cmd.Payload)

	// Scheduled tasks (Windows)
	case tools.CmdTasksList:
		result = tools.ListTasks(cmd.Payload)
	case tools.CmdTaskGet:
		result = tools.GetTask(cmd.Payload)
	case tools.CmdTaskRun:
		result = tools.RunTask(cmd.Payload)
	case tools.CmdTaskEnable:
		result = tools.EnableTask(cmd.Payload)
	case tools.CmdTaskDisable:
		result = tools.DisableTask(cmd.Payload)

	// Registry (Windows)
	case tools.CmdRegistryKeys:
		result = tools.ListRegistryKeys(cmd.Payload)
	case tools.CmdRegistryValues:
		result = tools.ListRegistryValues(cmd.Payload)
	case tools.CmdRegistryGet:
		result = tools.GetRegistryValue(cmd.Payload)
	case tools.CmdRegistrySet:
		result = tools.SetRegistryValue(cmd.Payload)
	case tools.CmdRegistryDelete:
		result = tools.DeleteRegistryValue(cmd.Payload)

	// System
	case tools.CmdReboot:
		result = tools.Reboot(cmd.Payload)
	case tools.CmdShutdown:
		result = tools.Shutdown(cmd.Payload)
	case tools.CmdLock:
		result = tools.Lock(cmd.Payload)

	// Software inventory
	case tools.CmdCollectSoftware:
		start := time.Now()
		collector := collectors.NewSoftwareCollector()
		software, err := collector.Collect()
		if err != nil {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(software, time.Since(start).Milliseconds())
		}

	// File transfer
	case tools.CmdFileTransfer:
		start := time.Now()
		transferResult := h.fileTransferMgr.HandleTransfer(cmd.Payload)
		result = tools.NewSuccessResult(transferResult, time.Since(start).Milliseconds())
		if status, ok := transferResult["status"].(string); ok && status == "failed" {
			if errMsg, ok := transferResult["error"].(string); ok {
				result = tools.CommandResult{
					Status:     "failed",
					Error:      errMsg,
					DurationMs: time.Since(start).Milliseconds(),
				}
			}
		}

	case tools.CmdCancelTransfer:
		start := time.Now()
		if transferID, ok := cmd.Payload["transferId"].(string); ok {
			h.fileTransferMgr.CancelTransfer(transferID)
			result = tools.NewSuccessResult(map[string]any{"cancelled": true}, time.Since(start).Milliseconds())
		} else {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing transferId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		}

	// Remote desktop
	case tools.CmdStartDesktop:
		start := time.Now()
		sessionID, _ := cmd.Payload["sessionId"].(string)
		offer, _ := cmd.Payload["offer"].(string)
		if sessionID == "" || offer == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing sessionId or offer",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			answer, err := h.desktopMgr.StartSession(sessionID, offer)
			if err != nil {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				result = tools.NewSuccessResult(map[string]any{
					"sessionId": sessionID,
					"answer":    answer,
				}, time.Since(start).Milliseconds())
			}
		}

	case tools.CmdStopDesktop:
		start := time.Now()
		if sessionID, ok := cmd.Payload["sessionId"].(string); ok {
			h.desktopMgr.StopSession(sessionID)
			result = tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
		} else {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing sessionId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		}

	// Remote desktop (WebSocket streaming)
	case tools.CmdDesktopStreamStart:
		start := time.Now()
		sessionID, _ := cmd.Payload["sessionId"].(string)
		if sessionID == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing sessionId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			config := desktop.DefaultStreamConfig()
			if q, ok := cmd.Payload["quality"].(float64); ok && q >= 1 && q <= 100 {
				config.Quality = int(q)
			}
			if s, ok := cmd.Payload["scaleFactor"].(float64); ok && s > 0 && s <= 1.0 {
				config.ScaleFactor = s
			}
			if f, ok := cmd.Payload["maxFps"].(float64); ok && f >= 1 && f <= 30 {
				config.MaxFPS = int(f)
			}

			w, h2, err := h.wsDesktopMgr.StartSession(sessionID, config, func(sid string, data []byte) error {
				if h.wsClient != nil {
					return h.wsClient.SendDesktopFrame(sid, data)
				}
				return fmt.Errorf("ws client not available")
			})
			if err != nil {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				result = tools.NewSuccessResult(map[string]any{
					"sessionId":    sessionID,
					"screenWidth":  w,
					"screenHeight": h2,
				}, time.Since(start).Milliseconds())
			}
		}

	case tools.CmdDesktopStreamStop:
		start := time.Now()
		sessionID, _ := cmd.Payload["sessionId"].(string)
		if sessionID == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing sessionId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			h.wsDesktopMgr.StopSession(sessionID)
			result = tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
		}

	case tools.CmdDesktopInput:
		start := time.Now()
		sessionID, _ := cmd.Payload["sessionId"].(string)
		if sessionID == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing sessionId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			event := desktop.InputEvent{}
			if e, ok := cmd.Payload["event"].(map[string]any); ok {
				event.Type, _ = e["type"].(string)
				if x, ok := e["x"].(float64); ok {
					event.X = int(x)
				}
				if y, ok := e["y"].(float64); ok {
					event.Y = int(y)
				}
				event.Button, _ = e["button"].(string)
				event.Key, _ = e["key"].(string)
				if d, ok := e["delta"].(float64); ok {
					event.Delta = int(d)
				}
				if mods, ok := e["modifiers"].([]any); ok {
					for _, m := range mods {
						if ms, ok := m.(string); ok {
							event.Modifiers = append(event.Modifiers, ms)
						}
					}
				}
			}
			if err := h.wsDesktopMgr.HandleInput(sessionID, event); err != nil {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				result = tools.NewSuccessResult(map[string]any{"ok": true}, time.Since(start).Milliseconds())
			}
		}

	case tools.CmdDesktopConfig:
		start := time.Now()
		sessionID, _ := cmd.Payload["sessionId"].(string)
		if sessionID == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing sessionId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			config := desktop.StreamConfig{}
			if q, ok := cmd.Payload["quality"].(float64); ok {
				config.Quality = int(q)
			}
			if s, ok := cmd.Payload["scaleFactor"].(float64); ok {
				config.ScaleFactor = s
			}
			if f, ok := cmd.Payload["maxFps"].(float64); ok {
				config.MaxFPS = int(f)
			}
			if err := h.wsDesktopMgr.UpdateConfig(sessionID, config); err != nil {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				result = tools.NewSuccessResult(map[string]any{"ok": true}, time.Since(start).Milliseconds())
			}
		}

	// Terminal commands
	case tools.CmdTerminalStart:
		result = tools.StartTerminal(h.terminalMgr, cmd.Payload, h.sendTerminalOutput)
	case tools.CmdTerminalData:
		result = tools.WriteTerminal(h.terminalMgr, cmd.Payload)
	case tools.CmdTerminalResize:
		result = tools.ResizeTerminal(h.terminalMgr, cmd.Payload)
	case tools.CmdTerminalStop:
		result = tools.StopTerminal(h.terminalMgr, cmd.Payload)

	// Script execution (via secure executor)
	case tools.CmdScript, tools.CmdRunScript:
		start := time.Now()
		script := executor.ScriptExecution{
			ID:         cmd.ID,
			ScriptID:   tools.GetPayloadString(cmd.Payload, "scriptId", ""),
			ScriptType: tools.GetPayloadString(cmd.Payload, "language", "bash"),
			Script:     tools.GetPayloadString(cmd.Payload, "content", ""),
			Timeout:    tools.GetPayloadInt(cmd.Payload, "timeoutSeconds", 300),
			RunAs:      tools.GetPayloadString(cmd.Payload, "runAs", ""),
		}
		if params, ok := cmd.Payload["parameters"].(map[string]any); ok {
			script.Parameters = make(map[string]string, len(params))
			for k, v := range params {
				if s, ok := v.(string); ok {
					script.Parameters[k] = s
				}
			}
		}
		if script.Script == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "script content is empty",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			scriptResult, execErr := h.executor.Execute(script)
			if execErr != nil && scriptResult == nil {
				result = tools.NewErrorResult(execErr, time.Since(start).Milliseconds())
			} else {
				status := "completed"
				if scriptResult.ExitCode != 0 {
					status = "failed"
				}
				if scriptResult.Error != "" && strings.Contains(scriptResult.Error, "timed out") {
					status = "timeout"
				}
				result = tools.CommandResult{
					Status:     status,
					ExitCode:   scriptResult.ExitCode,
					Stdout:     executor.SanitizeOutput(scriptResult.Stdout),
					Stderr:     executor.SanitizeOutput(scriptResult.Stderr),
					Error:      scriptResult.Error,
					DurationMs: time.Since(start).Milliseconds(),
				}
			}
		}

	// Script cancel
	case tools.CmdScriptCancel:
		start := time.Now()
		executionID := tools.GetPayloadString(cmd.Payload, "executionId", "")
		if executionID == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing executionId",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else if err := h.executor.Cancel(executionID); err != nil {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(map[string]any{
				"executionId": executionID,
				"cancelled":   true,
			}, time.Since(start).Milliseconds())
		}

	// Script list running
	case tools.CmdScriptListRunning:
		start := time.Now()
		running := h.executor.ListRunning()
		result = tools.NewSuccessResult(map[string]any{
			"running": running,
			"count":   len(running),
		}, time.Since(start).Milliseconds())

	// Backup management
	case tools.CmdBackupRun:
		start := time.Now()
		if h.backupMgr == nil {
			result = tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
		} else {
			job, err := h.backupMgr.RunBackup()
			if err != nil && job == nil {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				jobResult := map[string]any{
					"jobId":  job.ID,
					"status": job.Status,
				}
				if job.Snapshot != nil {
					jobResult["snapshotId"] = job.Snapshot.ID
					jobResult["filesBackedUp"] = job.FilesBackedUp
					jobResult["bytesBackedUp"] = job.BytesBackedUp
				}
				if job.Error != nil {
					jobResult["warning"] = job.Error.Error()
				}
				result = tools.NewSuccessResult(jobResult, time.Since(start).Milliseconds())
			}
		}

	case tools.CmdBackupList:
		start := time.Now()
		if h.backupMgr == nil {
			result = tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
		} else {
			snapshots, err := backup.ListSnapshots(h.backupMgr.GetProvider())
			if err != nil && len(snapshots) == 0 {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				result = tools.NewSuccessResult(map[string]any{
					"snapshots": snapshots,
					"count":     len(snapshots),
				}, time.Since(start).Milliseconds())
			}
		}

	case tools.CmdBackupStop:
		start := time.Now()
		if h.backupMgr == nil {
			result = tools.NewErrorResult(fmt.Errorf("backup not configured"), time.Since(start).Milliseconds())
		} else {
			h.backupMgr.Stop()
			result = tools.NewSuccessResult(map[string]any{"stopped": true}, time.Since(start).Milliseconds())
		}

	// Patch management
	case tools.CmdPatchScan:
		start := time.Now()
		pendingItems, installedItems, err := h.collectPatchInventory()
		if err != nil && len(pendingItems) == 0 && len(installedItems) == 0 {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			break
		}

		h.sendInventoryData("patches", map[string]interface{}{
			"patches":   pendingItems,
			"installed": installedItems,
		}, fmt.Sprintf("patches (%d pending, %d installed)", len(pendingItems), len(installedItems)))

		result = tools.NewSuccessResult(map[string]any{
			"pendingCount":   len(pendingItems),
			"installedCount": len(installedItems),
			"warning":        errorString(err),
		}, time.Since(start).Milliseconds())

	case tools.CmdInstallPatches:
		result = h.executePatchInstallCommand(cmd.Payload, false)

	case tools.CmdRollbackPatches:
		result = h.executePatchInstallCommand(cmd.Payload, true)

	// Security status collection
	case tools.CmdSecurityCollectStatus:
		start := time.Now()
		status, err := security.CollectStatus(h.config)
		if err != nil {
			result = tools.NewSuccessResult(map[string]any{
				"status":  status,
				"warning": err.Error(),
			}, time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(status, time.Since(start).Milliseconds())
		}

	// Security scan execution
	case tools.CmdSecurityScan:
		start := time.Now()
		scanType := strings.ToLower(tools.GetPayloadString(cmd.Payload, "scanType", "quick"))
		scanRecordID := tools.GetPayloadString(cmd.Payload, "scanRecordId", "")
		paths := tools.GetPayloadStringSlice(cmd.Payload, "paths")

		if h.securityScanner == nil {
			h.securityScanner = &security.SecurityScanner{Config: h.config}
		}

		var (
			scanResult security.ScanResult
			err        error
		)
		switch scanType {
		case "quick":
			scanResult, err = h.securityScanner.QuickScan()
		case "full":
			scanResult, err = h.securityScanner.FullScan()
		case "custom":
			if len(paths) == 0 {
				err = fmt.Errorf("custom scan requires one or more paths")
			} else {
				scanResult, err = h.securityScanner.CustomScan(paths)
			}
		default:
			err = fmt.Errorf("unsupported scanType: %s", scanType)
		}

		if err != nil {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			break
		}

		if runtime.GOOS == "windows" && tools.GetPayloadBool(cmd.Payload, "triggerDefender", false) && scanType != "custom" {
			if defErr := security.TriggerDefenderScan(scanType); defErr != nil {
				cmdLog.Warn("defender scan trigger warning", "error", defErr)
			}
		}

		result = tools.NewSuccessResult(map[string]any{
			"scanRecordId": scanRecordID,
			"scanType":     scanType,
			"durationMs":   scanResult.Duration.Milliseconds(),
			"threatsFound": len(scanResult.Threats),
			"threats":      scanResult.Threats,
			"status":       scanResult.Status,
		}, time.Since(start).Milliseconds())

	// Threat actions
	case tools.CmdSecurityThreatQuarantine:
		start := time.Now()
		path := tools.GetPayloadString(cmd.Payload, "path", "")
		if path == "" {
			result = tools.NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
			break
		}
		quarantineDir := tools.GetPayloadString(cmd.Payload, "quarantineDir", security.DefaultQuarantineDir())
		dest, err := security.QuarantineThreat(security.Threat{
			Name:     tools.GetPayloadString(cmd.Payload, "name", ""),
			Type:     tools.GetPayloadString(cmd.Payload, "threatType", "malware"),
			Severity: tools.GetPayloadString(cmd.Payload, "severity", "medium"),
			Path:     path,
		}, quarantineDir)
		if err != nil {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(map[string]any{
				"path":          path,
				"quarantinedTo": dest,
				"status":        "quarantined",
			}, time.Since(start).Milliseconds())
		}

	case tools.CmdSecurityThreatRemove:
		start := time.Now()
		path := tools.GetPayloadString(cmd.Payload, "path", "")
		if path == "" {
			result = tools.NewErrorResult(fmt.Errorf("path is required"), time.Since(start).Milliseconds())
			break
		}
		err := security.RemoveThreat(security.Threat{
			Name:     tools.GetPayloadString(cmd.Payload, "name", ""),
			Type:     tools.GetPayloadString(cmd.Payload, "threatType", "malware"),
			Severity: tools.GetPayloadString(cmd.Payload, "severity", "medium"),
			Path:     path,
		})
		if err != nil {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(map[string]any{
				"path":   path,
				"status": "removed",
			}, time.Since(start).Milliseconds())
		}

	case tools.CmdSecurityThreatRestore:
		start := time.Now()
		source := tools.GetPayloadString(cmd.Payload, "quarantinedPath", "")
		originalPath := tools.GetPayloadString(cmd.Payload, "originalPath", "")
		if source == "" || originalPath == "" {
			result = tools.NewErrorResult(fmt.Errorf("quarantinedPath and originalPath are required"), time.Since(start).Milliseconds())
			break
		}
		if err := os.MkdirAll(filepath.Dir(originalPath), 0755); err != nil {
			result = tools.NewErrorResult(fmt.Errorf("failed to create restore directory: %w", err), time.Since(start).Milliseconds())
			break
		}
		if err := os.Rename(source, originalPath); err != nil {
			result = tools.NewErrorResult(fmt.Errorf("failed to restore file: %w", err), time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(map[string]any{
				"quarantinedPath": source,
				"originalPath":    originalPath,
				"status":          "restored",
			}, time.Since(start).Milliseconds())
		}

	// File operations
	case tools.CmdFileList:
		result = tools.ListFiles(cmd.Payload)
	case tools.CmdFileRead:
		result = tools.ReadFile(cmd.Payload)
	case tools.CmdFileWrite:
		result = tools.WriteFile(cmd.Payload)
	case tools.CmdFileDelete:
		result = tools.DeleteFile(cmd.Payload)
	case tools.CmdFileMkdir:
		result = tools.MakeDirectory(cmd.Payload)
	case tools.CmdFileRename:
		result = tools.RenameFile(cmd.Payload)

	// Network discovery
	case tools.CmdNetworkDiscovery:
		start := time.Now()
		scanConfig := discovery.ScanConfig{
			Subnets:          tools.GetPayloadStringSlice(cmd.Payload, "subnets"),
			ExcludeIPs:       tools.GetPayloadStringSlice(cmd.Payload, "excludeIps"),
			Methods:          tools.GetPayloadStringSlice(cmd.Payload, "methods"),
			PortRanges:       tools.GetPayloadStringSlice(cmd.Payload, "portRanges"),
			SNMPCommunities:  tools.GetPayloadStringSlice(cmd.Payload, "snmpCommunities"),
			Timeout:          time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 2)) * time.Second,
			Concurrency:      tools.GetPayloadInt(cmd.Payload, "concurrency", 128),
			DeepScan:         tools.GetPayloadBool(cmd.Payload, "deepScan", false),
			IdentifyOS:       tools.GetPayloadBool(cmd.Payload, "identifyOS", false),
			ResolveHostnames: tools.GetPayloadBool(cmd.Payload, "resolveHostnames", false),
		}
		scanner := discovery.NewScanner(scanConfig)
		hosts, err := scanner.Scan()
		if err != nil {
			result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
		} else {
			result = tools.NewSuccessResult(map[string]any{
				"jobId":           tools.GetPayloadString(cmd.Payload, "jobId", ""),
				"hosts":           hosts,
				"hostsScanned":    0,
				"hostsDiscovered": len(hosts),
			}, time.Since(start).Milliseconds())
		}

	// SNMP polling
	case tools.CmdSnmpPoll:
		start := time.Now()
		target := tools.GetPayloadString(cmd.Payload, "target", "")
		if target == "" {
			result = tools.CommandResult{
				Status:     "failed",
				Error:      "missing SNMP target",
				DurationMs: time.Since(start).Milliseconds(),
			}
		} else {
			version := tools.GetPayloadString(cmd.Payload, "version", "v2c")
			var snmpVersion snmppoll.SNMPVersion
			switch version {
			case "v1":
				snmpVersion = 0x00
			case "v3":
				snmpVersion = 0x03
			default:
				snmpVersion = 0x01
			}

			device := snmppoll.SNMPDevice{
				IP:      target,
				Port:    uint16(tools.GetPayloadInt(cmd.Payload, "port", 161)),
				Version: snmpVersion,
				Auth: snmppoll.SNMPAuth{
					Community: tools.GetPayloadString(cmd.Payload, "community", "public"),
					Username:  tools.GetPayloadString(cmd.Payload, "username", ""),
				},
				OIDs:    tools.GetPayloadStringSlice(cmd.Payload, "oids"),
				Timeout: time.Duration(tools.GetPayloadInt(cmd.Payload, "timeout", 2)) * time.Second,
				Retries: tools.GetPayloadInt(cmd.Payload, "retries", 1),
			}

			metrics, err := snmppoll.CollectMetrics(device)
			if err != nil {
				result = tools.NewErrorResult(err, time.Since(start).Milliseconds())
			} else {
				result = tools.NewSuccessResult(map[string]any{
					"deviceId": tools.GetPayloadString(cmd.Payload, "deviceId", ""),
					"metrics":  metrics,
				}, time.Since(start).Milliseconds())
			}
		}

	default:
		result = tools.CommandResult{
			Status: "failed",
			Error:  fmt.Sprintf("unknown command type: %s", cmd.Type),
		}
	}

	// Audit: command executed
	if h.auditLog != nil {
		h.auditLog.Log(audit.EventCommandExecuted, cmd.ID, map[string]any{
			"type":       cmd.Type,
			"status":     result.Status,
			"durationMs": result.DurationMs,
		})
	}

	return result
}

type patchCommandRef struct {
	ID         string
	Source     string
	ExternalID string
	Title      string
}

func (h *Heartbeat) executePatchInstallCommand(payload map[string]any, rollback bool) tools.CommandResult {
	start := time.Now()
	if h.patchMgr == nil || len(h.patchMgr.ProviderIDs()) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patch providers available"), time.Since(start).Milliseconds())
	}

	refs := h.patchRefsFromPayload(payload)
	if len(refs) == 0 {
		return tools.NewErrorResult(fmt.Errorf("no patches provided"), time.Since(start).Milliseconds())
	}

	results := make([]map[string]any, 0, len(refs))
	successCount := 0
	failedCount := 0
	rebootRequired := false

	for _, ref := range refs {
		installID, resolveErr := h.resolvePatchInstallID(ref)
		if resolveErr != nil {
			failedCount++
			results = append(results, map[string]any{
				"id":     ref.ID,
				"status": "failed",
				"error":  resolveErr.Error(),
			})
			continue
		}

		if rollback {
			if err := h.patchMgr.Uninstall(installID); err != nil {
				failedCount++
				results = append(results, map[string]any{
					"id":        ref.ID,
					"installId": installID,
					"status":    "failed",
					"error":     err.Error(),
				})
				continue
			}
			successCount++
			results = append(results, map[string]any{
				"id":        ref.ID,
				"installId": installID,
				"status":    "rolled_back",
			})
			continue
		}

		installResult, err := h.patchMgr.Install(installID)
		if err != nil {
			failedCount++
			results = append(results, map[string]any{
				"id":        ref.ID,
				"installId": installID,
				"status":    "failed",
				"error":     err.Error(),
			})
			continue
		}

		successCount++
		rebootRequired = rebootRequired || installResult.RebootRequired
		results = append(results, map[string]any{
			"id":             ref.ID,
			"installId":      installID,
			"status":         "installed",
			"rebootRequired": installResult.RebootRequired,
			"message":        installResult.Message,
		})
	}

	summary := map[string]any{
		"success":        failedCount == 0,
		"installedCount": successCount,
		"failedCount":    failedCount,
		"rebootRequired": rebootRequired,
		"results":        results,
	}
	if rollback {
		summary["rolledBackCount"] = successCount
	}

	durationMs := time.Since(start).Milliseconds()
	if failedCount > 0 {
		stdout, _ := json.Marshal(summary)
		return tools.CommandResult{
			Status:     "failed",
			ExitCode:   1,
			Stdout:     string(stdout),
			Error:      fmt.Sprintf("%d patch operations failed", failedCount),
			DurationMs: durationMs,
		}
	}

	return tools.NewSuccessResult(summary, durationMs)
}

func (h *Heartbeat) patchRefsFromPayload(payload map[string]any) []patchCommandRef {
	refs := make([]patchCommandRef, 0)
	seen := map[string]struct{}{}

	if rawPatches, ok := payload["patches"].([]any); ok {
		for _, item := range rawPatches {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			ref := patchCommandRef{
				ID:         tools.GetPayloadString(obj, "id", tools.GetPayloadString(obj, "patchId", "")),
				Source:     tools.GetPayloadString(obj, "source", ""),
				ExternalID: tools.GetPayloadString(obj, "externalId", ""),
				Title:      tools.GetPayloadString(obj, "title", ""),
			}
			key := fmt.Sprintf("%s|%s|%s", ref.ID, ref.Source, ref.ExternalID)
			if key == "||" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			refs = append(refs, ref)
		}
	}

	for _, id := range tools.GetPayloadStringSlice(payload, "patchIds") {
		key := fmt.Sprintf("%s||", id)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		refs = append(refs, patchCommandRef{ID: id})
	}

	return refs
}

func (h *Heartbeat) resolvePatchInstallID(ref patchCommandRef) (string, error) {
	if h.patchMgr == nil {
		return "", fmt.Errorf("patch manager unavailable")
	}

	if provider, local, ok := splitPatchID(ref.ID); ok && h.patchMgr.HasProvider(provider) {
		return provider + ":" + local, nil
	}
	if provider, local, ok := splitPatchID(ref.ExternalID); ok {
		switch provider {
		case "microsoft", "apple", "linux", "third_party", "custom":
		case "dnf":
			if h.patchMgr.HasProvider("yum") {
				return "yum:" + local, nil
			}
		default:
			if h.patchMgr.HasProvider(provider) {
				return provider + ":" + local, nil
			}
		}
	}

	providerID := h.providerForPatchRef(ref)
	if providerID == "" {
		providerID = h.patchMgr.DefaultProviderID()
	}
	if providerID == "" {
		return "", fmt.Errorf("no provider available for patch %q", ref.ID)
	}

	localID := patchLocalID(ref)
	if localID == "" {
		return "", fmt.Errorf("unable to resolve local patch identifier for %q", ref.ID)
	}

	return providerID + ":" + localID, nil
}

func (h *Heartbeat) providerForPatchRef(ref patchCommandRef) string {
	source := strings.ToLower(strings.TrimSpace(ref.Source))
	switch source {
	case "microsoft":
		if h.patchMgr.HasProvider("windows-update") {
			return "windows-update"
		}
		if h.patchMgr.HasProvider("chocolatey") {
			return "chocolatey"
		}
	case "apple":
		if externalLooksLikeHomebrew(ref.ExternalID) && h.patchMgr.HasProvider("homebrew") {
			return "homebrew"
		}
		if h.patchMgr.HasProvider("apple-softwareupdate") {
			return "apple-softwareupdate"
		}
		if h.patchMgr.HasProvider("homebrew") {
			return "homebrew"
		}
	case "linux":
		if h.patchMgr.HasProvider("apt") {
			return "apt"
		}
		if h.patchMgr.HasProvider("yum") {
			return "yum"
		}
	case "third_party":
		for _, providerID := range []string{"homebrew", "chocolatey", "apt", "yum"} {
			if h.patchMgr.HasProvider(providerID) {
				return providerID
			}
		}
	}

	if provider, _, ok := splitPatchID(ref.ExternalID); ok && h.patchMgr.HasProvider(provider) {
		return provider
	}
	if provider, _, ok := splitPatchID(ref.ID); ok && h.patchMgr.HasProvider(provider) {
		return provider
	}

	return ""
}

func splitPatchID(value string) (string, string, bool) {
	parts := strings.SplitN(strings.TrimSpace(value), ":", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func patchLocalID(ref patchCommandRef) string {
	if _, local, ok := splitPatchID(ref.ExternalID); ok {
		parts := strings.SplitN(ref.ExternalID, ":", 3)
		if len(parts) == 3 && isSourcePrefix(parts[0]) && parts[1] != "" {
			return parts[1]
		}
		return local
	}
	if _, local, ok := splitPatchID(ref.ID); ok {
		return local
	}
	if ref.ExternalID != "" {
		return ref.ExternalID
	}
	if ref.ID != "" {
		return ref.ID
	}
	return ref.Title
}

func externalLooksLikeHomebrew(externalID string) bool {
	prefix, _, ok := splitPatchID(externalID)
	if !ok {
		return false
	}
	return prefix == "homebrew" || prefix == "brew" || prefix == "cask"
}

func isSourcePrefix(prefix string) bool {
	switch strings.ToLower(prefix) {
	case "microsoft", "apple", "linux", "third_party", "custom":
		return true
	default:
		return false
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// handleUpgrade performs an auto-update to the specified version
func (h *Heartbeat) handleUpgrade(targetVersion string) {
	log.Info("upgrade requested", "targetVersion", targetVersion)

	binaryPath, err := os.Executable()
	if err != nil {
		log.Error("failed to get executable path", "error", err)
		return
	}

	binaryPath, err = filepath.EvalSymlinks(binaryPath)
	if err != nil {
		log.Error("failed to resolve symlinks", "error", err)
		return
	}

	backupPath := binaryPath + ".backup"

	updaterCfg := &updater.Config{
		ServerURL:      h.config.ServerURL,
		AuthToken:      h.config.AuthToken,
		CurrentVersion: h.agentVersion,
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	}

	u := updater.New(updaterCfg)
	if err := u.UpdateTo(targetVersion); err != nil {
		log.Error("failed to update", "targetVersion", targetVersion, "error", err)
		return
	}

	log.Info("update successful", "targetVersion", targetVersion)
}

