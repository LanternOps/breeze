package heartbeat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/filetransfer"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/websocket"
)

type HeartbeatPayload struct {
	Metrics      *collectors.SystemMetrics `json:"metrics"`
	Status       string                    `json:"status"`
	AgentVersion string                    `json:"agentVersion"`
	PendingReboot bool                     `json:"pendingReboot,omitempty"`
	LastUser     string                    `json:"lastUser,omitempty"`
}

type HeartbeatResponse struct {
	Commands     []Command          `json:"commands"`
	ConfigUpdate map[string]any     `json:"configUpdate,omitempty"`
	UpgradeTo    string             `json:"upgradeTo,omitempty"`
}

type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type Heartbeat struct {
	config          *config.Config
	client          *http.Client
	stopChan        chan struct{}
	metricsCol      *collectors.MetricsCollector
	agentVersion    string
	fileTransferMgr *filetransfer.Manager
	desktopMgr      *desktop.SessionManager
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

	return &Heartbeat{
		config:          cfg,
		client:          &http.Client{Timeout: 30 * time.Second},
		stopChan:        make(chan struct{}),
		metricsCol:      collectors.NewMetricsCollector(),
		agentVersion:    version,
		fileTransferMgr: filetransfer.NewManager(ftConfig),
		desktopMgr:      desktop.NewSessionManager(),
	}
}

func (h *Heartbeat) Start() {
	ticker := time.NewTicker(time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second)
	defer ticker.Stop()

	// Send initial heartbeat immediately
	h.sendHeartbeat()

	for {
		select {
		case <-ticker.C:
			h.sendHeartbeat()
		case <-h.stopChan:
			return
		}
	}
}

func (h *Heartbeat) Stop() {
	close(h.stopChan)
}

func (h *Heartbeat) sendHeartbeat() {
	metrics, err := h.metricsCol.Collect()
	if err != nil {
		fmt.Printf("Error collecting metrics: %v\n", err)
		metrics = &collectors.SystemMetrics{}
	}

	status := "ok"
	if metrics.CPUPercent > 90 || metrics.RAMPercent > 90 || metrics.DiskPercent > 90 {
		status = "warning"
	}

	payload := HeartbeatPayload{
		Metrics:      metrics,
		Status:       status,
		AgentVersion: h.agentVersion,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		fmt.Printf("Error marshaling heartbeat: %v\n", err)
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", h.config.ServerURL, h.config.AgentID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		fmt.Printf("Error creating heartbeat request: %v\n", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.config.AuthToken)

	resp, err := h.client.Do(req)
	if err != nil {
		fmt.Printf("Error sending heartbeat: %v\n", err)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Printf("Heartbeat returned status %d\n", resp.StatusCode)
		return
	}

	var response HeartbeatResponse
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		fmt.Printf("Error decoding heartbeat response: %v\n", err)
		return
	}

	// Process any commands
	for _, cmd := range response.Commands {
		go h.processCommand(cmd)
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
		fmt.Printf("Error submitting command result: %v\n", err)
	}
}

func (h *Heartbeat) submitCommandResult(commandID string, result tools.CommandResult) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", h.config.ServerURL, h.config.AgentID, commandID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+h.config.AuthToken)

	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("submit result failed with status %d", resp.StatusCode)
	}

	fmt.Printf("Command %s completed with status: %s\n", commandID, result.Status)
	return nil
}

// HandleCommand processes a command from WebSocket and returns a result
// This is used by the WebSocket client to process commands
func (h *Heartbeat) HandleCommand(wsCmd websocket.Command) websocket.CommandResult {
	// Convert websocket.Command to internal Command
	cmd := Command{
		ID:      wsCmd.ID,
		Type:    wsCmd.Type,
		Payload: wsCmd.Payload,
	}

	// Process the command
	result := h.executeCommand(cmd)

	// Convert result to websocket.CommandResult
	wsResult := websocket.CommandResult{
		CommandID: cmd.ID,
		Status:    result.Status,
	}

	if result.Error != "" {
		wsResult.Error = result.Error
	} else if result.Stdout != "" {
		// Try to parse stdout as JSON for structured results
		var jsonResult any
		if err := json.Unmarshal([]byte(result.Stdout), &jsonResult); err == nil {
			wsResult.Result = jsonResult
		} else {
			wsResult.Result = result.Stdout
		}
	}

	// Also submit result via HTTP to keep database in sync
	go h.submitCommandResult(cmd.ID, result)

	return wsResult
}

// executeCommand runs a command and returns the result
func (h *Heartbeat) executeCommand(cmd Command) tools.CommandResult {
	fmt.Printf("Processing command: %s (type: %s)\n", cmd.ID, cmd.Type)

	var result tools.CommandResult

	// Dispatch to appropriate handler based on command type
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

	default:
		result = tools.CommandResult{
			Status: "failed",
			Error:  fmt.Sprintf("unknown command type: %s", cmd.Type),
		}
	}

	return result
}

// handleUpgrade performs an auto-update to the specified version
func (h *Heartbeat) handleUpgrade(targetVersion string) {
	fmt.Printf("Upgrade requested to version %s\n", targetVersion)

	// Get current binary path
	binaryPath, err := os.Executable()
	if err != nil {
		fmt.Printf("Failed to get executable path: %v\n", err)
		return
	}

	// Resolve any symlinks
	binaryPath, err = filepath.EvalSymlinks(binaryPath)
	if err != nil {
		fmt.Printf("Failed to resolve symlinks: %v\n", err)
		return
	}

	// Create backup path
	backupPath := binaryPath + ".backup"

	// Create updater config
	updaterCfg := &updater.Config{
		ServerURL:      h.config.ServerURL,
		AuthToken:      h.config.AuthToken,
		CurrentVersion: h.agentVersion,
		BinaryPath:     binaryPath,
		BackupPath:     backupPath,
	}

	// Create updater and perform update
	u := updater.New(updaterCfg)
	if err := u.UpdateTo(targetVersion); err != nil {
		fmt.Printf("Failed to update to version %s: %v\n", targetVersion, err)
		return
	}

	fmt.Printf("Successfully updated to version %s\n", targetVersion)
}
