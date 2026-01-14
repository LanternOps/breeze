package heartbeat

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
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
	config     *config.Config
	client     *http.Client
	stopChan   chan struct{}
	metricsCol *collectors.MetricsCollector
}

func New(cfg *config.Config) *Heartbeat {
	return &Heartbeat{
		config:     cfg,
		client:     &http.Client{Timeout: 30 * time.Second},
		stopChan:   make(chan struct{}),
		metricsCol: collectors.NewMetricsCollector(),
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
		AgentVersion: "0.1.0",
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
}

func (h *Heartbeat) processCommand(cmd Command) {
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

	default:
		result = tools.CommandResult{
			Status: "failed",
			Error:  fmt.Sprintf("unknown command type: %s", cmd.Type),
		}
	}

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
