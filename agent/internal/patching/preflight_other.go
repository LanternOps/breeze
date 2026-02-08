//go:build !windows

package patching

import "github.com/breeze-rmm/agent/internal/config"

// PreflightOptions configures which pre-flight checks to run before patching.
type PreflightOptions struct {
	CheckServiceHealth bool
	CheckDiskSpace     bool
	MinDiskSpaceGB     float64
	CheckACPower       bool
	CheckMaintWindow   bool
	MaintenanceStart   string
	MaintenanceEnd     string
	MaintenanceDays    []string
}

// PreflightResult captures the outcome of all pre-flight checks.
type PreflightResult struct {
	OK       bool
	Checks   []PreflightCheck
	Warnings []string
}

// PreflightCheck is one individual check result.
type PreflightCheck struct {
	Name    string
	Passed  bool
	Message string
}

// PreflightOptionsFromConfig builds PreflightOptions from config fields.
func PreflightOptionsFromConfig(cfg *config.Config) PreflightOptions {
	return PreflightOptions{}
}

// RunPreflight on non-Windows always returns OK.
func RunPreflight(_ PreflightOptions) PreflightResult {
	return PreflightResult{OK: true}
}

// FirstError returns nil on non-Windows (no checks run).
func (r PreflightResult) FirstError() error {
	return nil
}

// CreateRestorePoint is a no-op on non-Windows.
func CreateRestorePoint(_ string) error {
	return nil
}
