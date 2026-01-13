package heartbeat

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/pkg/models"
	"go.uber.org/zap"
)

// MetricsProvider defines the interface for collecting metrics
type MetricsProvider interface {
	Collect() (*models.Metrics, error)
}

// HeartbeatManager manages the heartbeat loop with the server
type HeartbeatManager struct {
	config          *config.Config
	client          *http.Client
	metricsProvider MetricsProvider
	cmdHandler      CommandHandler
	logger          *zap.Logger

	startTime time.Time
	stopCh    chan struct{}
	doneCh    chan struct{}
	mu        sync.RWMutex

	// Backoff state
	consecutiveFailures int
	maxBackoffDuration  time.Duration
	baseBackoffDuration time.Duration
}

// New creates a new HeartbeatManager
func New(cfg *config.Config, metricsProvider MetricsProvider, logger *zap.Logger) *HeartbeatManager {
	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: cfg.InsecureSkipVerify,
		},
		MaxIdleConns:        10,
		IdleConnTimeout:     30 * time.Second,
		DisableCompression:  false,
		TLSHandshakeTimeout: 10 * time.Second,
	}

	client := &http.Client{
		Transport: transport,
		Timeout:   30 * time.Second,
	}

	return &HeartbeatManager{
		config:              cfg,
		client:              client,
		metricsProvider:     metricsProvider,
		logger:              logger.Named("heartbeat"),
		startTime:           time.Now(),
		stopCh:              make(chan struct{}),
		doneCh:              make(chan struct{}),
		maxBackoffDuration:  5 * time.Minute,
		baseBackoffDuration: 5 * time.Second,
	}
}

// SetCommandHandler sets the handler for processing commands from the server
func (h *HeartbeatManager) SetCommandHandler(handler CommandHandler) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.cmdHandler = handler
}

// Start begins the heartbeat loop
func (h *HeartbeatManager) Start() error {
	h.logger.Info("starting heartbeat manager",
		zap.Duration("interval", h.config.HeartbeatInterval),
		zap.String("server", h.config.ServerURL),
	)

	go h.run()
	return nil
}

// Stop gracefully stops the heartbeat loop
func (h *HeartbeatManager) Stop() {
	h.logger.Info("stopping heartbeat manager")
	close(h.stopCh)
	<-h.doneCh
	h.logger.Info("heartbeat manager stopped")
}

// run is the main heartbeat loop
func (h *HeartbeatManager) run() {
	defer close(h.doneCh)

	// Send initial heartbeat immediately
	h.sendHeartbeatWithRetry()

	ticker := time.NewTicker(h.config.HeartbeatInterval)
	defer ticker.Stop()

	for {
		select {
		case <-h.stopCh:
			return
		case <-ticker.C:
			h.sendHeartbeatWithRetry()
		}
	}
}

// sendHeartbeatWithRetry sends a heartbeat and handles the response with backoff on failure
func (h *HeartbeatManager) sendHeartbeatWithRetry() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := h.sendHeartbeat(ctx)
	if err != nil {
		h.handleFailure(err)
		return
	}

	h.handleSuccess(resp)
}

// sendHeartbeat sends a heartbeat request to the server
func (h *HeartbeatManager) sendHeartbeat(ctx context.Context) (*models.HeartbeatResponse, error) {
	h.mu.RLock()
	cfg := h.config
	h.mu.RUnlock()

	// Build the heartbeat request
	req := models.HeartbeatRequest{
		DeviceID:     cfg.DeviceID,
		AgentVersion: getAgentVersion(),
		Uptime:       int64(time.Since(h.startTime).Seconds()),
	}

	// Include metrics if enabled and provider is available
	if cfg.EnableMetrics && h.metricsProvider != nil {
		metrics, err := h.metricsProvider.Collect()
		if err != nil {
			h.logger.Warn("failed to collect metrics for heartbeat", zap.Error(err))
		} else {
			req.Metrics = metrics
		}
	}

	// Serialize the request
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal heartbeat request: %w", err)
	}

	// Create the HTTP request
	url := fmt.Sprintf("%s/api/agents/heartbeat", cfg.ServerURL)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create heartbeat request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Device-ID", cfg.DeviceID)
	if cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+cfg.APIKey)
	}

	// Send the request
	h.logger.Debug("sending heartbeat",
		zap.String("url", url),
		zap.Int64("uptime", req.Uptime),
	)

	httpResp, err := h.client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("heartbeat request failed: %w", err)
	}
	defer httpResp.Body.Close()

	// Read the response body
	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read heartbeat response: %w", err)
	}

	// Check for non-success status codes
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return nil, fmt.Errorf("heartbeat returned status %d: %s", httpResp.StatusCode, string(respBody))
	}

	// Parse the response
	var resp models.HeartbeatResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, fmt.Errorf("failed to parse heartbeat response: %w", err)
	}

	return &resp, nil
}

// handleSuccess processes a successful heartbeat response
func (h *HeartbeatManager) handleSuccess(resp *models.HeartbeatResponse) {
	// Reset backoff on success
	h.consecutiveFailures = 0

	h.logger.Debug("heartbeat successful",
		zap.String("status", resp.Status),
		zap.Int("commands", len(resp.Commands)),
	)

	// Process config updates if present
	if resp.ConfigUpdate != nil {
		h.applyConfigUpdate(resp.ConfigUpdate)
	}

	// Queue commands for processing
	if len(resp.Commands) > 0 {
		h.queueCommands(resp.Commands)
	}
}

// handleFailure handles a failed heartbeat with exponential backoff
func (h *HeartbeatManager) handleFailure(err error) {
	h.consecutiveFailures++
	backoffDuration := h.calculateBackoff()

	h.logger.Error("heartbeat failed",
		zap.Error(err),
		zap.Int("consecutive_failures", h.consecutiveFailures),
		zap.Duration("next_backoff", backoffDuration),
	)
}

// calculateBackoff calculates the backoff duration using exponential backoff
func (h *HeartbeatManager) calculateBackoff() time.Duration {
	// Exponential backoff: base * 2^(failures-1), capped at max
	backoff := h.baseBackoffDuration * time.Duration(math.Pow(2, float64(h.consecutiveFailures-1)))
	if backoff > h.maxBackoffDuration {
		backoff = h.maxBackoffDuration
	}
	return backoff
}

// applyConfigUpdate applies configuration updates from the server
func (h *HeartbeatManager) applyConfigUpdate(update *models.ConfigUpdate) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.logger.Info("applying config update from server")

	if update.HeartbeatInterval != nil {
		newInterval := time.Duration(*update.HeartbeatInterval) * time.Second
		h.config.HeartbeatInterval = newInterval
		h.logger.Info("updated heartbeat interval", zap.Duration("interval", newInterval))
	}

	if update.MetricsInterval != nil {
		newInterval := time.Duration(*update.MetricsInterval) * time.Second
		h.config.MetricsInterval = newInterval
		h.logger.Info("updated metrics interval", zap.Duration("interval", newInterval))
	}

	if update.EnableMetrics != nil {
		h.config.EnableMetrics = *update.EnableMetrics
		h.logger.Info("updated enable_metrics", zap.Bool("enabled", *update.EnableMetrics))
	}

	if update.EnableRemote != nil {
		h.config.EnableRemote = *update.EnableRemote
		h.logger.Info("updated enable_remote", zap.Bool("enabled", *update.EnableRemote))
	}

	// Persist the config changes
	if err := h.config.Save(); err != nil {
		h.logger.Error("failed to save config update", zap.Error(err))
	}
}

// queueCommands sends commands to the command handler for processing
func (h *HeartbeatManager) queueCommands(commands []models.Command) {
	h.mu.RLock()
	handler := h.cmdHandler
	h.mu.RUnlock()

	if handler == nil {
		h.logger.Warn("received commands but no handler registered",
			zap.Int("count", len(commands)),
		)
		return
	}

	for _, cmd := range commands {
		h.logger.Info("queueing command",
			zap.String("id", cmd.ID),
			zap.String("type", cmd.Type),
			zap.Int("priority", cmd.Priority),
		)
		handler.QueueCommand(cmd)
	}
}

// GetUptime returns the agent uptime in seconds
func (h *HeartbeatManager) GetUptime() int64 {
	return int64(time.Since(h.startTime).Seconds())
}

// getAgentVersion returns the current agent version
func getAgentVersion() string {
	// This would typically be set at build time via ldflags
	return "1.0.0"
}
