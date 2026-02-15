package heartbeat

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v3/host"

	"github.com/breeze-rmm/agent/internal/audit"
	"github.com/breeze-rmm/agent/internal/backup"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/filetransfer"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/mgmtdetect"
	"github.com/breeze-rmm/agent/internal/mtls"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/security"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/terminal"
	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workerpool"
	"github.com/breeze-rmm/agent/pkg/api"
)

var log = logging.L("heartbeat")

type HeartbeatPayload struct {
	Metrics          *collectors.SystemMetrics `json:"metrics,omitempty"`
	MetricsAvailable *bool                     `json:"metricsAvailable,omitempty"`
	Status           string                    `json:"status"`
	AgentVersion     string                    `json:"agentVersion"`
	PendingReboot    bool                      `json:"pendingReboot,omitempty"`
	LastUser         string                    `json:"lastUser,omitempty"`
	UptimeSeconds    int64                     `json:"uptime,omitempty"`
	HealthStatus     map[string]any            `json:"healthStatus,omitempty"`
}

type HeartbeatResponse struct {
	Commands     []Command      `json:"commands"`
	ConfigUpdate map[string]any `json:"configUpdate,omitempty"`
	UpgradeTo    string         `json:"upgradeTo,omitempty"`
	RenewCert    bool           `json:"renewCert,omitempty"`
}

type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

type Heartbeat struct {
	config              *config.Config
	secureToken         *secmem.SecureString
	client              *http.Client
	stopChan            chan struct{}
	metricsCol          *collectors.MetricsCollector
	hardwareCol         *collectors.HardwareCollector
	softwareCol         *collectors.SoftwareCollector
	inventoryCol        *collectors.InventoryCollector
	sessionCol          *collectors.SessionCollector
	policyStateCol      *collectors.PolicyStateCollector
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
	rebootMgr           *patching.RebootManager
	securityScanner     *security.SecurityScanner
	wsClient            *websocket.Client
	mu                  sync.Mutex
	lastInventoryUpdate time.Time
	lastEventLogUpdate  time.Time
	lastSecurityUpdate  time.Time
	lastSessionUpdate   time.Time
	lastPostureUpdate   time.Time

	// User session helper (IPC)
	sessionBroker *sessionbroker.Broker

	// Resilience & observability
	pool        *workerpool.Pool
	healthMon   *health.Monitor
	auditLog    *audit.Logger
	accepting   atomic.Bool
	wg          sync.WaitGroup
	inventoryWg sync.WaitGroup
	retryCfg    httputil.RetryConfig
	stopOnce    sync.Once

	// Command deduplication: prevents the same commandId from being
	// executed twice when delivered via both WebSocket and heartbeat.
	seenCommands   map[string]time.Time
	seenCommandsMu sync.Mutex

	// Guard against concurrent cert renewals from successive heartbeats
	certRenewing atomic.Bool
}

func New(cfg *config.Config) *Heartbeat {
	return NewWithVersion(cfg, "0.1.0", nil, nil)
}

func NewWithVersion(cfg *config.Config, version string, token *secmem.SecureString, tlsCfg *tls.Config) *Heartbeat {
	ftToken := token
	if ftToken == nil && cfg.AuthToken != "" {
		ftToken = secmem.NewSecureString(cfg.AuthToken)
	}

	ftConfig := &filetransfer.Config{
		ServerURL: cfg.ServerURL,
		AuthToken: ftToken,
		AgentID:   cfg.AgentID,
	}

	// Build HTTP client with optional mTLS transport
	httpClient := &http.Client{Timeout: 30 * time.Second}
	if tlsCfg != nil {
		httpClient.Transport = &http.Transport{TLSClientConfig: tlsCfg}
	}

	h := &Heartbeat{
		config:          cfg,
		secureToken:     ftToken,
		client:          httpClient,
		stopChan:        make(chan struct{}),
		metricsCol:      collectors.NewMetricsCollector(),
		hardwareCol:     collectors.NewHardwareCollector(),
		softwareCol:     collectors.NewSoftwareCollector(),
		inventoryCol:    collectors.NewInventoryCollector(),
		sessionCol:      collectors.NewSessionCollector(),
		policyStateCol:  collectors.NewPolicyStateCollector(),
		patchCol:        collectors.NewPatchCollector(),
		patchMgr:        patching.NewDefaultManager(cfg),
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
		seenCommands:    make(map[string]time.Time),
	}
	h.accepting.Store(true)

	// Trigger wallpaper crash recovery (restores wallpaper if agent crashed mid-session)
	_ = desktop.GetWallpaperManager()

	// Initialize audit logger if enabled
	if cfg.AuditEnabled {
		auditLogger, err := audit.NewLogger(cfg)
		if err != nil {
			log.Error("failed to start audit logger", "error", err)
			h.healthMon.Update("audit", health.Unhealthy, err.Error())
		} else {
			h.auditLog = auditLogger
		}
	}

	// Initialize session broker for user helpers (IPC)
	if cfg.UserHelperEnabled {
		socketPath := cfg.IPCSocketPath
		if socketPath == "" {
			socketPath = ipc.DefaultSocketPath()
		}
		h.sessionBroker = sessionbroker.New(socketPath, h.handleUserHelperMessage)
		log.Info("user helper IPC enabled", "socket", socketPath)
	}

	// Register winget provider (dispatches via user helper for user-context execution)
	if runtime.GOOS == "windows" && h.sessionBroker != nil {
		h.patchMgr.RegisterProvider(patching.NewWingetProvider(h.makeUserExecFunc()))
		log.Info("winget provider registered (via user helper IPC)")
	}

	// Initialize reboot manager (uses session broker for user notifications)
	h.rebootMgr = patching.NewRebootManager(func(title, body, urgency string) {
		if h.sessionBroker != nil {
			h.sessionBroker.BroadcastNotification(title, body, urgency)
		}
	}, cfg.PatchRebootMaxPerDay)

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

// SessionBroker returns the session broker for user helper connections.
func (h *Heartbeat) SessionBroker() *sessionbroker.Broker {
	return h.sessionBroker
}

// handleUserHelperMessage processes messages from user helpers that aren't
// responses to pending commands (e.g., tray actions).
func (h *Heartbeat) handleUserHelperMessage(session *sessionbroker.Session, env *ipc.Envelope) {
	switch env.Type {
	case ipc.TypeTrayAction:
		log.Info("tray action from user helper", "uid", session.UID, "sessionId", session.SessionID)
	case ipc.TypeNotifyResult:
		log.Debug("notify result from user helper", "uid", session.UID)
	default:
		log.Debug("unhandled user helper message", "type", env.Type, "uid", session.UID)
	}
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
	// Start session broker for user helpers
	if h.sessionBroker != nil {
		go h.sessionBroker.Listen(h.stopChan)
	}
	if h.sessionCol != nil {
		h.sessionCol.Start(h.stopChan)
	}

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
	h.mu.Lock()
	h.lastPostureUpdate = time.Now()
	h.mu.Unlock()

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
			shouldSendSessions := time.Since(h.lastSessionUpdate) > 5*time.Minute
			if shouldSendSessions {
				h.lastSessionUpdate = time.Now()
			}
			shouldSendPosture := time.Since(h.lastPostureUpdate) > 15*time.Minute
			if shouldSendPosture {
				h.lastPostureUpdate = time.Now()
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
			if shouldSendSessions {
				go h.sendSessionInventory()
			}
			if shouldSendPosture {
				go h.sendManagementPosture()
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

// DrainAndWait waits for all in-flight commands and inventory goroutines to complete,
// respecting the context deadline.
func (h *Heartbeat) DrainAndWait(ctx context.Context) {
	log.Info("draining in-flight commands and inventory goroutines")
	h.pool.Drain(ctx)
	h.wg.Wait()

	// Wait for inventory goroutines with deadline
	done := make(chan struct{})
	go func() {
		h.inventoryWg.Wait()
		close(done)
	}()
	select {
	case <-done:
		log.Info("all commands and inventory goroutines drained")
	case <-ctx.Done():
		log.Warn("inventory goroutine drain timed out")
	}
}

func (h *Heartbeat) Stop() {
	h.stopOnce.Do(func() {
		if h.rebootMgr != nil {
			h.rebootMgr.Stop()
		}
		if h.backupMgr != nil {
			h.backupMgr.Stop()
		}
		if h.auditLog != nil {
			h.auditLog.Log(audit.EventAgentStop, "", nil)
			h.auditLog.Close()
		}
		// Close stopChan first — this signals broker.Listen() to call broker.Close()
		// internally. The broker's Close() is idempotent via its closed flag.
		close(h.stopChan)
	})
}

// sendInventory collects and sends hardware, software, disk, network, connections, and patch inventory.
// All goroutines are tracked via inventoryWg for graceful shutdown.
func (h *Heartbeat) sendInventory() {
	fns := []func(){
		h.sendHardwareInventory,
		h.sendSoftwareInventory,
		h.sendDiskInventory,
		h.sendNetworkInventory,
		h.sendSessionInventory,
		h.sendConnectionsInventory,
		h.sendPatchInventory,
		h.sendPolicyRegistryState,
		h.sendPolicyConfigState,
		h.sendSecurityStatus,
	}
	for _, fn := range fns {
		h.inventoryWg.Add(1)
		go func(f func()) {
			defer h.inventoryWg.Done()
			f()
		}(fn)
	}
}

// authHeader returns the Bearer token for HTTP Authorization headers.
// Prefers secureToken; falls back to config plaintext only if secureToken is nil.
func (h *Heartbeat) authHeader() string {
	if h.secureToken != nil && !h.secureToken.IsZeroed() {
		return "Bearer " + h.secureToken.Reveal()
	}
	if h.config.AuthToken != "" {
		return "Bearer " + h.config.AuthToken
	}
	log.Warn("authHeader called with no available token")
	return "Bearer "
}

// authTokenPlaintext returns the raw token string for use in external APIs
// (e.g., updater) that require a plain string, not a Bearer header.
func (h *Heartbeat) authTokenPlaintext() string {
	if h.secureToken != nil && !h.secureToken.IsZeroed() {
		return h.secureToken.Reveal()
	}
	return h.config.AuthToken
}

// sendInventoryData marshals the payload and sends it to the given endpoint via PUT.
func (h *Heartbeat) sendInventoryData(endpoint string, payload any, label string) {
	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal inventory", "label", label, "error", err)
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/%s", h.config.ServerURL, h.config.AgentID, endpoint)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
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

	items := make([]map[string]any, len(software))
	for i, item := range software {
		items[i] = map[string]any{
			"name":            item.Name,
			"version":         item.Version,
			"vendor":          item.Vendor,
			"installDate":     item.InstallDate,
			"installLocation": item.InstallLocation,
			"uninstallString": item.UninstallString,
		}
	}

	h.sendInventoryData("software", map[string]any{"software": items}, fmt.Sprintf("software (%d items)", len(software)))
}

func (h *Heartbeat) sendDiskInventory() {
	disks, err := h.inventoryCol.CollectDisks()
	if err != nil {
		log.Error("failed to collect disk inventory", "error", err)
		return
	}

	h.sendInventoryData("disks", map[string]any{"disks": disks}, fmt.Sprintf("disks (%d)", len(disks)))
}

func (h *Heartbeat) sendNetworkInventory() {
	adapters, err := h.inventoryCol.CollectNetworkAdapters()
	if err != nil {
		log.Error("failed to collect network inventory", "error", err)
		return
	}

	h.sendInventoryData("network", map[string]any{"adapters": adapters}, fmt.Sprintf("network (%d adapters)", len(adapters)))
}

func (h *Heartbeat) policyRegistryProbes() []collectors.RegistryProbe {
	h.mu.Lock()
	configured := slices.Clone(h.config.PolicyRegistryStateProbes)
	h.mu.Unlock()

	probes := make([]collectors.RegistryProbe, 0, len(configured))
	for _, probe := range configured {
		registryPath := strings.TrimSpace(probe.RegistryPath)
		valueName := strings.TrimSpace(probe.ValueName)
		if registryPath == "" || valueName == "" {
			continue
		}
		probes = append(probes, collectors.RegistryProbe{
			RegistryPath: registryPath,
			ValueName:    valueName,
		})
	}
	return probes
}

func (h *Heartbeat) policyConfigProbes() []collectors.ConfigProbe {
	h.mu.Lock()
	configured := slices.Clone(h.config.PolicyConfigStateProbes)
	h.mu.Unlock()

	probes := make([]collectors.ConfigProbe, 0, len(configured))
	for _, probe := range configured {
		filePath := strings.TrimSpace(probe.FilePath)
		configKey := strings.TrimSpace(probe.ConfigKey)
		if filePath == "" || configKey == "" {
			continue
		}
		probes = append(probes, collectors.ConfigProbe{
			FilePath:  filePath,
			ConfigKey: configKey,
		})
	}
	return probes
}

func normalizeProbePath(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func normalizeProbeKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func parsePolicyRegistryProbeList(raw any) ([]config.PolicyRegistryStateProbe, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}

	probes := make([]config.PolicyRegistryStateProbe, 0, len(items))
	seen := make(map[string]struct{})
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}

		registryPath := ""
		if value, exists := record["registry_path"]; exists {
			if typed, ok := value.(string); ok {
				registryPath = strings.TrimSpace(typed)
			}
		}
		if registryPath == "" {
			if value, exists := record["registryPath"]; exists {
				if typed, ok := value.(string); ok {
					registryPath = strings.TrimSpace(typed)
				}
			}
		}

		valueName := ""
		if value, exists := record["value_name"]; exists {
			if typed, ok := value.(string); ok {
				valueName = strings.TrimSpace(typed)
			}
		}
		if valueName == "" {
			if value, exists := record["valueName"]; exists {
				if typed, ok := value.(string); ok {
					valueName = strings.TrimSpace(typed)
				}
			}
		}

		if registryPath == "" || valueName == "" {
			continue
		}

		dedupeKey := normalizeProbePath(registryPath) + "::" + normalizeProbeKey(valueName)
		if _, exists := seen[dedupeKey]; exists {
			continue
		}
		seen[dedupeKey] = struct{}{}
		probes = append(probes, config.PolicyRegistryStateProbe{
			RegistryPath: registryPath,
			ValueName:    valueName,
		})
	}

	return probes, true
}

func parsePolicyConfigProbeList(raw any) ([]config.PolicyConfigStateProbe, bool) {
	items, ok := raw.([]any)
	if !ok {
		return nil, false
	}

	probes := make([]config.PolicyConfigStateProbe, 0, len(items))
	seen := make(map[string]struct{})
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}

		filePath := ""
		if value, exists := record["file_path"]; exists {
			if typed, ok := value.(string); ok {
				filePath = strings.TrimSpace(typed)
			}
		}
		if filePath == "" {
			if value, exists := record["filePath"]; exists {
				if typed, ok := value.(string); ok {
					filePath = strings.TrimSpace(typed)
				}
			}
		}

		configKey := ""
		if value, exists := record["config_key"]; exists {
			if typed, ok := value.(string); ok {
				configKey = strings.TrimSpace(typed)
			}
		}
		if configKey == "" {
			if value, exists := record["configKey"]; exists {
				if typed, ok := value.(string); ok {
					configKey = strings.TrimSpace(typed)
				}
			}
		}

		if filePath == "" || configKey == "" {
			continue
		}

		dedupeKey := normalizeProbePath(filePath) + "::" + normalizeProbeKey(configKey)
		if _, exists := seen[dedupeKey]; exists {
			continue
		}
		seen[dedupeKey] = struct{}{}
		probes = append(probes, config.PolicyConfigStateProbe{
			FilePath:  filePath,
			ConfigKey: configKey,
		})
	}

	return probes, true
}

func equalPolicyRegistryProbes(left, right []config.PolicyRegistryStateProbe) bool {
	if len(left) != len(right) {
		return false
	}
	for idx := range left {
		if !strings.EqualFold(strings.TrimSpace(left[idx].RegistryPath), strings.TrimSpace(right[idx].RegistryPath)) {
			return false
		}
		if !strings.EqualFold(strings.TrimSpace(left[idx].ValueName), strings.TrimSpace(right[idx].ValueName)) {
			return false
		}
	}
	return true
}

func equalPolicyConfigProbes(left, right []config.PolicyConfigStateProbe) bool {
	if len(left) != len(right) {
		return false
	}
	for idx := range left {
		if !strings.EqualFold(strings.TrimSpace(left[idx].FilePath), strings.TrimSpace(right[idx].FilePath)) {
			return false
		}
		if !strings.EqualFold(strings.TrimSpace(left[idx].ConfigKey), strings.TrimSpace(right[idx].ConfigKey)) {
			return false
		}
	}
	return true
}

func (h *Heartbeat) applyConfigUpdate(update map[string]any) {
	if len(update) == 0 {
		return
	}

	registryRaw, hasRegistry := update["policy_registry_state_probes"]
	if !hasRegistry {
		registryRaw, hasRegistry = update["policyRegistryStateProbes"]
	}

	configRaw, hasConfig := update["policy_config_state_probes"]
	if !hasConfig {
		configRaw, hasConfig = update["policyConfigStateProbes"]
	}

	if !hasRegistry && !hasConfig {
		return
	}

	var (
		parsedRegistry []config.PolicyRegistryStateProbe
		parsedConfig   []config.PolicyConfigStateProbe
		ok             bool
	)

	if hasRegistry {
		parsedRegistry, ok = parsePolicyRegistryProbeList(registryRaw)
		if !ok {
			log.Warn("ignoring invalid policy_registry_state_probes config update payload")
			hasRegistry = false
		}
	}
	if hasConfig {
		parsedConfig, ok = parsePolicyConfigProbeList(configRaw)
		if !ok {
			log.Warn("ignoring invalid policy_config_state_probes config update payload")
			hasConfig = false
		}
	}

	if !hasRegistry && !hasConfig {
		return
	}

	registryChanged := false
	configChanged := false
	registryCount := 0
	configCount := 0

	h.mu.Lock()
	if hasRegistry && !equalPolicyRegistryProbes(h.config.PolicyRegistryStateProbes, parsedRegistry) {
		h.config.PolicyRegistryStateProbes = parsedRegistry
		registryChanged = true
	}
	if hasConfig && !equalPolicyConfigProbes(h.config.PolicyConfigStateProbes, parsedConfig) {
		h.config.PolicyConfigStateProbes = parsedConfig
		configChanged = true
	}
	registryCount = len(h.config.PolicyRegistryStateProbes)
	configCount = len(h.config.PolicyConfigStateProbes)
	h.mu.Unlock()

	if registryChanged || configChanged {
		log.Info(
			"applied config update",
			"policyRegistryStateProbes", registryCount,
			"policyConfigStateProbes", configCount,
		)
	}
}

func (h *Heartbeat) sendPolicyRegistryState() {
	entries, err := h.policyStateCol.CollectRegistryState(h.policyRegistryProbes())
	if err != nil {
		log.Warn("failed to collect policy registry state", "error", err)
	}

	h.sendInventoryData(
		"registry-state",
		map[string]any{
			"entries": entries,
			"replace": true,
		},
		fmt.Sprintf("registry state (%d entries)", len(entries)),
	)
}

func (h *Heartbeat) sendPolicyConfigState() {
	entries, err := h.policyStateCol.CollectConfigState(h.policyConfigProbes())
	if err != nil {
		log.Warn("failed to collect policy config state", "error", err)
	}

	h.sendInventoryData(
		"config-state",
		map[string]any{
			"entries": entries,
			"replace": true,
		},
		fmt.Sprintf("config state (%d entries)", len(entries)),
	)
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

	h.sendInventoryData("patches", map[string]any{
		"patches":   pendingItems,
		"installed": installedItems,
	}, fmt.Sprintf("patches (%d pending, %d installed)", len(pendingItems), len(installedItems)))
}

func (h *Heartbeat) collectPatchInventory() ([]map[string]any, []map[string]any, error) {
	if h.patchMgr != nil && len(h.patchMgr.ProviderIDs()) > 0 {
		available, scanErr := h.patchMgr.Scan()
		installed, installedErr := h.patchMgr.GetInstalled()

		pendingItems := h.availablePatchesToMaps(available)
		installedItems := h.installedPatchesToMaps(installed)

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

func (h *Heartbeat) availablePatchesToMaps(patches []patching.AvailablePatch) []map[string]any {
	items := make([]map[string]any, len(patches))
	for i, p := range patches {
		severity := p.Severity
		if severity == "" {
			severity = "unknown"
		}
		category := p.Category
		if category == "" {
			category = h.mapPatchProviderCategory(p.Provider)
		}
		// Homebrew provider IDs encode casks as "homebrew:cask:<name>".
		// Preserve that distinction so UI can show richer macOS package details.
		if p.Provider == "homebrew" {
			if strings.HasPrefix(p.ID, "homebrew:cask:") {
				category = "homebrew-cask"
			} else {
				category = "homebrew"
			}
		}
		items[i] = map[string]any{
			"name":            p.Title,
			"version":         p.Version,
			"category":        category,
			"severity":        severity,
			"description":     p.Description,
			"source":          h.mapPatchProviderSource(p.Provider),
			"externalId":      p.KBNumber,
			"kbNumber":        p.KBNumber,
			"size":            p.Size,
			"requiresRestart": p.RebootRequired,
			"releaseDate":     p.ReleaseDate,
		}
	}
	return items
}

func (h *Heartbeat) installedPatchesToMaps(patches []patching.InstalledPatch) []map[string]any {
	items := make([]map[string]any, len(patches))
	for i, p := range patches {
		category := p.Category
		if category == "" {
			category = h.mapPatchProviderCategory(p.Provider)
		}
		m := map[string]any{
			"name":     p.Title,
			"version":  p.Version,
			"category": category,
			"source":   h.mapPatchProviderSource(p.Provider),
		}
		if p.KBNumber != "" {
			m["kbNumber"] = p.KBNumber
		}
		if p.InstalledAt != "" {
			m["installedAt"] = p.InstalledAt
		}
		items[i] = m
	}
	return items
}

func (h *Heartbeat) collectPatchInventoryFromCollectors() ([]map[string]any, []map[string]any, error) {
	patches, collectErr := h.patchCol.Collect()
	installedPatches, installedErr := h.patchCol.CollectInstalled(90 * 24 * time.Hour)

	pendingItems := make([]map[string]any, len(patches))
	for i, patch := range patches {
		pendingItems[i] = map[string]any{
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

	installedItems := make([]map[string]any, len(installedPatches))
	for i, patch := range installedPatches {
		installedItems[i] = map[string]any{
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

	items := make([]map[string]any, len(connections))
	for i, conn := range connections {
		items[i] = map[string]any{
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

	h.sendInventoryData("connections", map[string]any{"connections": items}, fmt.Sprintf("connections (%d active)", len(connections)))
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

	h.sendInventoryData("eventlogs", map[string]any{"events": events}, fmt.Sprintf("event logs (%d events)", len(events)))
}

func (h *Heartbeat) sendSecurityStatus() {
	status, err := security.CollectStatus(h.config)
	if err != nil {
		log.Warn("security status collection warning", "error", err)
	}

	h.sendInventoryData("security/status", status, "security status")
}

func (h *Heartbeat) sendManagementPosture() {
	posture := mgmtdetect.CollectPosture()
	total := 0
	for _, dets := range posture.Categories {
		total += len(dets)
	}
	h.sendInventoryData("management/posture", posture, fmt.Sprintf("management posture (%d detections)", total))
}

func (h *Heartbeat) sendSessionInventory() {
	if h.sessionCol == nil {
		return
	}

	sessions, err := h.sessionCol.Collect()
	if err != nil {
		log.Warn("failed to collect sessions", "error", err)
		return
	}
	events := h.sessionCol.DrainEvents(256)

	payload := map[string]any{
		"sessions":    sessions,
		"events":      events,
		"collectedAt": time.Now().UTC(),
	}
	h.sendInventoryData("sessions", payload, fmt.Sprintf("sessions (%d active, %d events)", len(sessions), len(events)))
}

func (h *Heartbeat) sendHeartbeat() {
	metrics, err := h.metricsCol.Collect()
	metricsAvailable := true
	if err != nil {
		log.Error("failed to collect metrics", "error", err)
		h.healthMon.Update("metrics", health.Degraded, err.Error())
		metricsAvailable = false
	} else {
		h.healthMon.Update("metrics", health.Healthy, "")
	}

	status := "ok"
	if metricsAvailable && (metrics.CPUPercent > 90 || metrics.RAMPercent > 90 || metrics.DiskPercent > 90) {
		status = "warning"
	}

	payload := HeartbeatPayload{
		Status:       status,
		AgentVersion: h.agentVersion,
		HealthStatus: h.healthMon.Summary(),
	}
	if metricsAvailable {
		payload.Metrics = metrics
	} else {
		payload.MetricsAvailable = &metricsAvailable
	}

	// Check for pending reboot
	pendingReboot, _ := patching.DetectPendingReboot()
	payload.PendingReboot = pendingReboot
	if h.sessionCol != nil {
		payload.LastUser = h.sessionCol.LastUser()
	}

	// Compute uptime from boot time
	if bootTime, err := host.BootTime(); err != nil {
		log.Warn("failed to read boot time for uptime calculation", "error", err)
	} else if bootTime > 0 {
		payload.UptimeSeconds = time.Now().Unix() - int64(bootTime)
	}

	// Include user helper session info in heartbeat
	if h.sessionBroker != nil {
		sessions := h.sessionBroker.AllSessions()
		if len(sessions) > 0 {
			helpers := make([]map[string]any, len(sessions))
			for i, s := range sessions {
				helpers[i] = map[string]any{
					"uid":         s.UID,
					"username":    s.Username,
					"display":     s.DisplayEnv,
					"connectedAt": s.ConnectedAt,
					"lastSeen":    s.LastSeen,
				}
				if s.Capabilities != nil {
					helpers[i]["capabilities"] = s.Capabilities
				}
			}
			payload.HealthStatus["userHelpers"] = helpers
		}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		log.Error("failed to marshal heartbeat", "error", err)
		return
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/heartbeat", h.config.ServerURL, h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
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

	if len(response.ConfigUpdate) > 0 {
		h.applyConfigUpdate(response.ConfigUpdate)
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

	// Handle mTLS cert renewal if signaled by server
	if response.RenewCert {
		go h.handleCertRenewal()
	}
}

// handleCertRenewal is called in a goroutine when the server signals renewCert: true.
// It uses a bearer-only client (no mTLS required) to call /renew-cert.
// Guarded by certRenewing to prevent concurrent renewals from successive heartbeats.
func (h *Heartbeat) handleCertRenewal() {
	if !h.certRenewing.CompareAndSwap(false, true) {
		log.Info("mTLS cert renewal already in progress, skipping")
		return
	}
	defer h.certRenewing.Store(false)

	log.Info("mTLS cert renewal requested by server")

	token := h.secureToken.Reveal()
	renewClient := api.NewClient(h.config.ServerURL, token, h.config.AgentID)

	renewResp, err := renewClient.RenewCert()
	if err != nil {
		log.Error("mTLS cert renewal failed", "error", err)
		return
	}

	if renewResp.Quarantined {
		log.Warn("device quarantined during cert renewal")
		return
	}

	if renewResp.Error != "" {
		log.Error("mTLS cert renewal rejected", "error", renewResp.Error)
		return
	}

	if renewResp.Mtls == nil {
		log.Warn("mTLS cert renewal response missing cert data")
		return
	}

	// Validate the cert/key pair before saving
	if _, verifyErr := mtls.LoadClientCert(renewResp.Mtls.Certificate, renewResp.Mtls.PrivateKey); verifyErr != nil {
		log.Error("renewed cert/key pair is invalid, not saving", "error", verifyErr)
		return
	}

	// Update config in memory (hold mutex to prevent races with heartbeat reads)
	h.mu.Lock()
	defer h.mu.Unlock()

	h.config.MtlsCertPEM = renewResp.Mtls.Certificate
	h.config.MtlsKeyPEM = renewResp.Mtls.PrivateKey
	h.config.MtlsCertExpires = renewResp.Mtls.ExpiresAt

	// Save to disk (temporarily restore auth token for save)
	h.config.AuthToken = token
	err = config.Save(h.config)
	h.config.AuthToken = ""

	if err != nil {
		log.Error("failed to save renewed mTLS cert -- renewal will be re-attempted", "error", err)
		// Clear expires so next heartbeat re-triggers renewal
		h.config.MtlsCertExpires = ""
		return
	}

	log.Info("mTLS certificate renewed", "expires", renewResp.Mtls.ExpiresAt)
	// New cert will be used on next WebSocket reconnect
}

func (h *Heartbeat) processCommand(cmd Command) {
	result := h.executeCommand(cmd)

	if result.Status == "duplicate" {
		return
	}

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
		"Authorization": {h.authHeader()},
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

	if result.Status != "duplicate" && !isEphemeralCommand(cmd.Type) {
		go h.submitCommandResult(cmd.ID, result)
	}

	return wsResult
}

func isEphemeralCommand(cmdType string) bool {
	switch cmdType {
	case tools.CmdTerminalStart, tools.CmdTerminalData, tools.CmdTerminalResize, tools.CmdTerminalStop,
		tools.CmdStartDesktop, tools.CmdStopDesktop,
		tools.CmdDesktopStreamStart, tools.CmdDesktopStreamStop, tools.CmdDesktopInput, tools.CmdDesktopConfig:
		return true
	}
	return false
}

// markCommandSeen returns true if this is the first time seeing the command ID.
// It also evicts entries older than 2 minutes to prevent unbounded growth.
func (h *Heartbeat) markCommandSeen(id string) bool {
	h.seenCommandsMu.Lock()
	defer h.seenCommandsMu.Unlock()

	if h.seenCommands == nil {
		h.seenCommands = make(map[string]time.Time)
	}

	if _, seen := h.seenCommands[id]; seen {
		return false
	}

	h.seenCommands[id] = time.Now()

	// Evict entries older than 2 minutes when map grows past 100
	if len(h.seenCommands) > 100 {
		cutoff := time.Now().Add(-2 * time.Minute)
		for k, t := range h.seenCommands {
			if t.Before(cutoff) {
				delete(h.seenCommands, k)
			}
		}
	}

	return true
}

// executeCommand runs a command and returns the result.
// Command dispatch is handled via the handler registry in handlers*.go.
func (h *Heartbeat) executeCommand(cmd Command) tools.CommandResult {
	cmdLog := logging.WithCommand(log, cmd.ID, cmd.Type)

	// Deduplicate: skip if we've already seen this command ID
	// (can arrive via both WebSocket and heartbeat response)
	if !h.markCommandSeen(cmd.ID) {
		cmdLog.Debug("skipping duplicate command")
		return tools.CommandResult{
			Status: "duplicate",
		}
	}

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

	// Dispatch via handler registry
	result, handled := h.dispatchCommand(cmd)
	if !handled {
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

	authToken := h.authTokenPlaintext()
	updaterCfg := &updater.Config{
		ServerURL:      h.config.ServerURL,
		AuthToken:      authToken,
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

// makeUserExecFunc returns a UserExecFunc that dispatches commands to a connected
// user helper via the session broker IPC. This enables providers like winget that
// require user-context execution.
func (h *Heartbeat) makeUserExecFunc() patching.UserExecFunc {
	return func(name string, args []string, timeout time.Duration) (string, string, int, error) {
		if h.sessionBroker == nil {
			return "", "", -1, fmt.Errorf("no session broker available")
		}

		// Find first available user helper session
		sessions := h.sessionBroker.AllSessions()
		if len(sessions) == 0 {
			return "", "", -1, fmt.Errorf("no user helper connected")
		}

		session := h.sessionBroker.SessionForUser(sessions[0].Username)
		if session == nil {
			return "", "", -1, fmt.Errorf("user helper session not found")
		}

		if !session.HasScope("run_as_user") {
			return "", "", -1, fmt.Errorf("user helper does not have run_as_user scope")
		}

		// Build a script execution command payload
		payload := map[string]any{
			"type":    "exec",
			"command": name,
			"args":    args,
		}
		payloadBytes, err := json.Marshal(payload)
		if err != nil {
			return "", "", -1, fmt.Errorf("marshal exec payload: %w", err)
		}

		cmdID := fmt.Sprintf("winget-%d", time.Now().UnixNano())
		ipcCmd := ipc.IPCCommand{
			CommandID: cmdID,
			Type:      "exec",
			Payload:   payloadBytes,
		}

		resp, err := session.SendCommand(cmdID, ipc.TypeCommand, ipcCmd, timeout+5*time.Second)
		if err != nil {
			return "", "", -1, fmt.Errorf("user helper exec: %w", err)
		}
		if resp == nil {
			return "", "", -1, fmt.Errorf("user helper session closed during exec")
		}

		var result ipc.IPCCommandResult
		if err := json.Unmarshal(resp.Payload, &result); err != nil {
			return "", "", -1, fmt.Errorf("unmarshal exec result: %w", err)
		}

		var stdout, stderr string
		var exitCode int
		if result.Result != nil {
			var nested map[string]any
			if err := json.Unmarshal(result.Result, &nested); err == nil {
				if s, ok := nested["stdout"].(string); ok {
					stdout = s
				}
				if s, ok := nested["stderr"].(string); ok {
					stderr = s
				}
				if c, ok := nested["exitCode"].(float64); ok {
					exitCode = int(c)
				}
			}
		}

		if result.Status == "failed" {
			return stdout, stderr, exitCode, fmt.Errorf("exec failed: %s", result.Error)
		}

		return stdout, stderr, exitCode, nil
	}
}
