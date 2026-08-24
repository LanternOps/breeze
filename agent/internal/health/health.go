package health

import (
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("health")

// Status represents the health status of a component.
type Status string

const (
	Healthy   Status = "healthy"
	Degraded  Status = "degraded"
	Unhealthy Status = "unhealthy"
	Unknown   Status = "unknown"
)

// IsValid returns true if the status is a recognized value.
func (s Status) IsValid() bool {
	switch s {
	case Healthy, Degraded, Unhealthy, Unknown:
		return true
	default:
		return false
	}
}

// Check stores the latest health result for a named component.
type Check struct {
	Name      string    `json:"name"`
	Status    Status    `json:"status"`
	Message   string    `json:"message,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// AgentHealthState is the stable v1 wire state understood by the API.
type AgentHealthState string

const (
	AgentHealthHealthy AgentHealthState = "healthy"
	AgentHealthWarning AgentHealthState = "warning"
	AgentHealthError   AgentHealthState = "error"
	AgentHealthUnknown AgentHealthState = "unknown"
)

// AgentHealthComponent is an immutable component value in a v1 observation.
type AgentHealthComponent struct {
	State  AgentHealthState `json:"state"`
	Reason string           `json:"reason,omitempty"`
}

// AgentHealthObservation is the versioned self-health snapshot sent by the
// main agent. MetricsAvailable is intentionally not omitempty: nil serializes
// as JSON null, preserving "not observed" separately from false.
type AgentHealthObservation struct {
	SchemaVersion    int                             `json:"schemaVersion"`
	DeviceID         string                          `json:"deviceId,omitempty"`
	AgentVersion     string                          `json:"agentVersion"`
	Overall          AgentHealthState                `json:"overall"`
	MetricsAvailable *bool                           `json:"metricsAvailable"`
	Components       map[string]AgentHealthComponent `json:"components"`
	ObservedAt       time.Time                       `json:"observedAt"`
}

// SnapshotMetadata binds one monitor snapshot to its producer and observation
// time without making those transport concerns part of Monitor state.
type SnapshotMetadata struct {
	DeviceID         string
	AgentVersion     string
	MetricsAvailable *bool
	ObservedAt       time.Time
}

// Monitor tracks health checks for multiple components.
type Monitor struct {
	mu     sync.RWMutex
	checks map[string]Check
}

// NewMonitor creates a new health monitor.
func NewMonitor() *Monitor {
	return &Monitor{
		checks: make(map[string]Check),
	}
}

// Update records the health status for a named component.
// Invalid status values are coerced to Unhealthy with a warning.
func (m *Monitor) Update(name string, status Status, message string) {
	if !status.IsValid() {
		log.Warn("invalid health status, coercing to unhealthy",
			"component", name, "status", string(status))
		status = Unhealthy
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	m.checks[name] = Check{
		Name:      name,
		Status:    status,
		Message:   message,
		UpdatedAt: time.Now(),
	}

	if status != Healthy {
		log.Warn("health check degraded", "component", name, "status", string(status), "message", message)
	}
}

// Get returns the health check for a named component.
func (m *Monitor) Get(name string) (Check, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	c, ok := m.checks[name]
	return c, ok
}

// Overall returns the worst status across all registered checks.
// If no checks are registered, returns Unknown (fail-safe).
func (m *Monitor) Overall() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.overallLocked()
}

// overallLocked computes the worst status; caller must hold at least RLock.
func (m *Monitor) overallLocked() Status {
	if len(m.checks) == 0 {
		return Unknown
	}

	worst := Healthy
	for _, c := range m.checks {
		if worse(c.Status, worst) {
			worst = c.Status
		}
	}
	return worst
}

// All returns a snapshot of all current health checks.
func (m *Monitor) All() []Check {
	m.mu.RLock()
	defer m.mu.RUnlock()

	result := make([]Check, 0, len(m.checks))
	for _, c := range m.checks {
		result = append(result, c)
	}
	return result
}

// Snapshot returns a typed immutable copy for the heartbeat wire. It holds one
// RLock across overall and component derivation, so readers never observe a
// mixture of two monitor revisions.
func (m *Monitor) Snapshot(meta SnapshotMetadata) AgentHealthObservation {
	m.mu.RLock()
	defer m.mu.RUnlock()

	components := make(map[string]AgentHealthComponent, len(m.checks))
	for _, c := range m.checks {
		components[c.Name] = AgentHealthComponent{
			State:  toAgentHealthState(c.Status),
			Reason: c.Message,
		}
	}

	var metricsAvailable *bool
	if meta.MetricsAvailable != nil {
		value := *meta.MetricsAvailable
		metricsAvailable = &value
	}

	return AgentHealthObservation{
		SchemaVersion:    1,
		DeviceID:         meta.DeviceID,
		AgentVersion:     meta.AgentVersion,
		Overall:          toAgentHealthState(m.overallLocked()),
		MetricsAvailable: metricsAvailable,
		Components:       components,
		ObservedAt:       meta.ObservedAt.UTC(),
	}
}

func toAgentHealthState(status Status) AgentHealthState {
	switch status {
	case Healthy:
		return AgentHealthHealthy
	case Degraded:
		return AgentHealthWarning
	case Unhealthy:
		return AgentHealthError
	case Unknown:
		return AgentHealthUnknown
	default:
		return AgentHealthUnknown
	}
}

// worse returns true if a is worse than b.
func worse(a, b Status) bool {
	return statusRank(a) > statusRank(b)
}

// statusRank maps status to severity: Healthy(0) < Degraded(1) < Unhealthy(2) < Unknown(3).
// Unknown is ranked worst so that uninitialized or unrecognized statuses
// are treated as the most severe condition (fail-safe).
func statusRank(s Status) int {
	switch s {
	case Healthy:
		return 0
	case Degraded:
		return 1
	case Unhealthy:
		return 2
	case Unknown:
		return 3
	default:
		return 3 // unknown status treated as worst
	}
}
