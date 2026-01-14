// Package tools provides remote management utilities for the Breeze RMM agent.
package tools

import (
	"sync"
)

// WindowsService represents a Windows service with its properties.
type WindowsService struct {
	Name         string   `json:"name"`
	DisplayName  string   `json:"displayName"`
	Description  string   `json:"description"`
	Status       string   `json:"status"`      // running, stopped, paused, starting, stopping
	StartupType  string   `json:"startupType"` // automatic, manual, disabled, delayed-start
	Account      string   `json:"account"`     // LocalSystem, NetworkService, etc.
	Path         string   `json:"path"`
	Dependencies []string `json:"dependencies"`
}

// ServiceStatus constants for service state.
const (
	ServiceStatusRunning  = "running"
	ServiceStatusStopped  = "stopped"
	ServiceStatusPaused   = "paused"
	ServiceStatusStarting = "starting"
	ServiceStatusStopping = "stopping"
	ServiceStatusUnknown  = "unknown"
)

// StartupType constants for service startup configuration.
const (
	StartupTypeAutomatic    = "automatic"
	StartupTypeManual       = "manual"
	StartupTypeDisabled     = "disabled"
	StartupTypeDelayedStart = "delayed-start"
)

// ServiceManager provides methods for managing Windows services.
type ServiceManager struct {
	mu sync.Mutex
}

// NewServiceManager creates a new ServiceManager instance.
func NewServiceManager() *ServiceManager {
	return &ServiceManager{}
}
