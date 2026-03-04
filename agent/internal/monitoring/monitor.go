package monitoring

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("monitoring")

// SendResultsFunc is a callback that ships check results to the API.
type SendResultsFunc func(results []CheckResult)

// Monitor manages the lifecycle of service and process watches.
type Monitor struct {
	mu          sync.RWMutex
	config      MonitorConfig
	ticker      *time.Ticker
	stopCh      chan struct{}
	running     bool
	states      map[string]*watchState
	sendResults SendResultsFunc
}

type watchState struct {
	consecutiveFailures int
	lastRestartAttempt  time.Time
	restartAttempts     int
}

// New creates a new Monitor with the given results callback.
func New(sendResults SendResultsFunc) *Monitor {
	return &Monitor{
		states:      make(map[string]*watchState),
		sendResults: sendResults,
	}
}

// ApplyConfig updates the monitor configuration.
// If the monitor is running, it stops and restarts with the new config.
func (m *Monitor) ApplyConfig(cfg MonitorConfig) {
	m.mu.Lock()
	wasRunning := m.running
	m.mu.Unlock()

	if wasRunning {
		m.Stop()
	}

	m.mu.Lock()
	oldWatchNames := make(map[string]bool)
	for k := range m.states {
		oldWatchNames[k] = true
	}

	m.config = cfg

	// Add new watch states, keep existing ones
	newWatchNames := make(map[string]bool)
	for _, w := range cfg.Watches {
		key := w.WatchType + ":" + w.Name
		newWatchNames[key] = true
		if _, exists := m.states[key]; !exists {
			m.states[key] = &watchState{}
		}
	}

	// Remove states for watches no longer in config
	for k := range oldWatchNames {
		if !newWatchNames[k] {
			delete(m.states, k)
		}
	}
	m.mu.Unlock()

	if len(cfg.Watches) > 0 {
		m.Start()
	}

	log.Info("applied monitoring config", "watches", len(cfg.Watches), "intervalSeconds", cfg.CheckIntervalSeconds)
}

// Start begins the monitoring loop.
func (m *Monitor) Start() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.running {
		return
	}

	interval := m.config.CheckIntervalSeconds
	if interval < 10 {
		log.Warn("check interval below minimum, clamping to 10s", "requested", interval)
		interval = 10
	}

	m.stopCh = make(chan struct{})
	m.ticker = time.NewTicker(time.Duration(interval) * time.Second)
	m.running = true

	go m.loop()
	log.Info("monitoring started", "intervalSeconds", interval)
}

// Stop halts the monitoring loop.
func (m *Monitor) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()

	if !m.running {
		return
	}

	close(m.stopCh)
	m.ticker.Stop()
	m.running = false
	log.Info("monitoring stopped")
}

func (m *Monitor) loop() {
	// Run an immediate check on start
	m.runChecks()

	for {
		select {
		case <-m.stopCh:
			return
		case <-m.ticker.C:
			m.runChecks()
		}
	}
}

func (m *Monitor) runChecks() {
	m.mu.RLock()
	watches := make([]WatchConfig, len(m.config.Watches))
	copy(watches, m.config.Watches)
	m.mu.RUnlock()

	if len(watches) == 0 {
		return
	}

	var results []CheckResult

	for _, w := range watches {
		var result CheckResult

		switch w.WatchType {
		case WatchTypeService:
			result = checkService(w.Name)
		case WatchTypeProcess:
			result = checkProcess(w.Name, w.CpuThresholdPercent, w.MemoryThresholdMb)
		default:
			result = CheckResult{
				WatchType: w.WatchType,
				Name:      w.Name,
				Status:    StatusError,
				Details:   map[string]any{"error": "unsupported watch type"},
			}
		}

		result.WatchType = w.WatchType
		result.Name = w.Name

		// Handle auto-restart (maybeAutoRestart sets AutoRestartSucceeded on result directly)
		if result.Status != StatusRunning && w.AutoRestart {
			attempted, _ := m.maybeAutoRestart(w, &result)
			result.AutoRestartAttempted = attempted
		}

		// Track consecutive failures
		m.mu.Lock()
		key := w.WatchType + ":" + w.Name
		state, ok := m.states[key]
		if !ok {
			state = &watchState{}
			m.states[key] = state
		}

		if result.Status != StatusRunning {
			state.consecutiveFailures++
		} else {
			state.consecutiveFailures = 0
			state.restartAttempts = 0
		}
		m.mu.Unlock()

		results = append(results, result)
	}

	if len(results) > 0 && m.sendResults != nil {
		m.sendResults(results)
	}
}

func (m *Monitor) maybeAutoRestart(w WatchConfig, result *CheckResult) (attempted, succeeded bool) {
	m.mu.Lock()
	key := w.WatchType + ":" + w.Name
	state, ok := m.states[key]
	if !ok {
		state = &watchState{}
		m.states[key] = state
	}

	// Check if we've exceeded max attempts
	if state.restartAttempts >= w.MaxRestartAttempts {
		m.mu.Unlock()
		return false, false
	}

	// Check cooldown
	cooldown := time.Duration(w.RestartCooldownSeconds) * time.Second
	if time.Since(state.lastRestartAttempt) < cooldown {
		m.mu.Unlock()
		return false, false
	}

	state.restartAttempts++
	state.lastRestartAttempt = time.Now()
	m.mu.Unlock()

	// Attempt restart
	var err error
	switch w.WatchType {
	case "service":
		err = restartService(w.Name)
	case "process":
		err = killProcess(w.Name)
	}

	if err != nil {
		log.Warn("auto-restart failed", "watchType", w.WatchType, "name", w.Name, "error", err.Error())
		f := false
		result.AutoRestartSucceeded = &f
		return true, false
	}

	log.Info("auto-restart succeeded", "watchType", w.WatchType, "name", w.Name)
	t := true
	result.AutoRestartSucceeded = &t
	return true, true
}

// ParseMonitorConfig parses a raw config update map into MonitorConfig.
func ParseMonitorConfig(raw any) (MonitorConfig, bool) {
	var cfg MonitorConfig

	data, err := json.Marshal(raw)
	if err != nil {
		log.Warn("failed to marshal monitoring config", "error", err.Error())
		return cfg, false
	}

	if err := json.Unmarshal(data, &cfg); err != nil {
		log.Warn("failed to parse monitoring config", "error", err.Error())
		return cfg, false
	}

	// Return true even for empty watches — ApplyConfig handles stopping
	// the monitor when no watches are configured. Returning false here
	// would be indistinguishable from a parse failure.
	return cfg, true
}
