package tools

import (
	"errors"
	"sync"
)

// Common errors
var (
	ErrProcessNotFound = errors.New("process not found")
	ErrAccessDenied    = errors.New("access denied")
	ErrKillFailed      = errors.New("failed to kill process")
)

// Process represents information about a running process
type Process struct {
	PID         int     `json:"pid"`
	Name        string  `json:"name"`
	Status      string  `json:"status"` // running, sleeping, stopped, zombie
	CPUPercent  float64 `json:"cpuPercent"`
	MemoryMB    float64 `json:"memoryMB"`
	User        string  `json:"user"`
	CommandLine string  `json:"commandLine"`
	ParentPID   int     `json:"parentPid"`
	StartTime   string  `json:"startTime"`
}

// ProcessManager handles process enumeration and management
type ProcessManager struct {
	mu sync.Mutex
}

// NewProcessManager creates a new ProcessManager instance
func NewProcessManager() *ProcessManager {
	return &ProcessManager{}
}
