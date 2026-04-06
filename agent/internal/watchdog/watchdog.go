package watchdog

import (
	"sync"
	"time"
)

// State constants represent the watchdog's operational states.
const (
	StateConnecting = "CONNECTING"
	StateMonitoring = "MONITORING"
	StateRecovering = "RECOVERING"
	StateStandby    = "STANDBY"
	StateFailover   = "FAILOVER"
)

// Event constants are the triggers that drive state transitions.
const (
	EventIPCConnected      = "ipc_connected"
	EventAgentNotFound     = "agent_not_found"
	EventAgentUnhealthy    = "agent_unhealthy"
	EventAgentRecovered    = "agent_recovered"
	EventShutdownIntent    = "shutdown_intent"
	EventRecoveryExhausted = "recovery_exhausted"
	EventStandbyTimeout    = "standby_timeout"
	EventStartAgent        = "start_agent"
)

// transitions is the static transition table: state → event → nextState.
var transitions = map[string]map[string]string{
	StateConnecting: {
		EventIPCConnected:  StateMonitoring,
		EventAgentNotFound: StateRecovering,
		EventAgentUnhealthy: StateRecovering,
	},
	StateMonitoring: {
		EventAgentUnhealthy: StateRecovering,
		EventShutdownIntent: StateStandby,
	},
	StateRecovering: {
		EventAgentRecovered:    StateMonitoring,
		EventRecoveryExhausted: StateFailover,
	},
	StateStandby: {
		EventAgentRecovered: StateMonitoring,
		EventStandbyTimeout: StateFailover,
		EventStartAgent:     StateRecovering,
	},
	StateFailover: {
		EventAgentRecovered: StateMonitoring,
	},
}

// Config holds all tuneable parameters for the watchdog.
type Config struct {
	ProcessCheckInterval    time.Duration
	IPCProbeInterval        time.Duration
	HeartbeatStaleThreshold time.Duration
	MaxRecoveryAttempts     int
	RecoveryCooldown        time.Duration
	StandbyTimeout          time.Duration
	FailoverPollInterval    time.Duration
}

// StateRecord captures a single state entry in the history.
type StateRecord struct {
	State     string    `json:"state"`
	EnteredAt time.Time `json:"entered_at"`
	Event     string    `json:"event"`
}

// Watchdog is a table-driven state machine for monitoring the agent process.
type Watchdog struct {
	mu      sync.RWMutex
	state   string
	config  Config
	history []StateRecord
}

// NewWatchdog creates a Watchdog starting in CONNECTING and records the initial
// history entry.
func NewWatchdog(cfg Config) *Watchdog {
	w := &Watchdog{
		state:  StateConnecting,
		config: cfg,
	}
	w.history = append(w.history, StateRecord{
		State:     StateConnecting,
		EnteredAt: time.Now(),
		Event:     "",
	})
	return w
}

// State returns the current state under a read lock.
func (w *Watchdog) State() string {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.state
}

// HandleEvent attempts a transition driven by event. If a valid transition
// exists, the state is updated, a history record is appended, and
// (newState, true) is returned. If no transition is defined,
// (currentState, false) is returned.
func (w *Watchdog) HandleEvent(event string) (string, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	nextState, ok := transitions[w.state][event]
	if !ok {
		return w.state, false
	}

	w.state = nextState
	w.history = append(w.history, StateRecord{
		State:     nextState,
		EnteredAt: time.Now(),
		Event:     event,
	})
	return nextState, true
}

// StateHistory returns a copy of the full state transition history.
func (w *Watchdog) StateHistory() []StateRecord {
	w.mu.RLock()
	defer w.mu.RUnlock()

	out := make([]StateRecord, len(w.history))
	copy(out, w.history)
	return out
}

// LastTransitionTime returns the time the watchdog entered its most recent state.
func (w *Watchdog) LastTransitionTime() time.Time {
	w.mu.RLock()
	defer w.mu.RUnlock()

	if len(w.history) == 0 {
		return time.Time{}
	}
	return w.history[len(w.history)-1].EnteredAt
}
