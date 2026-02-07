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
)

// Check stores the latest health result for a named component.
type Check struct {
	Name      string    `json:"name"`
	Status    Status    `json:"status"`
	Message   string    `json:"message,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
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
func (m *Monitor) Update(name string, status Status, message string) {
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
// If no checks are registered, returns Healthy.
func (m *Monitor) Overall() Status {
	m.mu.RLock()
	defer m.mu.RUnlock()

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

// Summary returns a JSON-friendly map for inclusion in heartbeat payloads.
func (m *Monitor) Summary() map[string]any {
	overall := m.Overall()
	checks := m.All()

	components := make(map[string]string, len(checks))
	for _, c := range checks {
		components[c.Name] = string(c.Status)
	}

	return map[string]any{
		"status":     string(overall),
		"components": components,
	}
}

// worse returns true if a is worse than b.
func worse(a, b Status) bool {
	return statusRank(a) > statusRank(b)
}

func statusRank(s Status) int {
	switch s {
	case Healthy:
		return 0
	case Degraded:
		return 1
	case Unhealthy:
		return 2
	default:
		return 0
	}
}
