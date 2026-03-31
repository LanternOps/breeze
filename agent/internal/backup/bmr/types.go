// Package bmr implements bare metal recovery orchestration for the Breeze agent.
package bmr

import "encoding/json"

const BootstrapResponseVersion = 1

// RecoveryConfig holds configuration for a BMR operation.
type RecoveryConfig struct {
	RecoveryToken string            `json:"recoveryToken"`
	ServerURL     string            `json:"serverUrl"`
	SnapshotID    string            `json:"snapshotId"`
	DeviceID      string            `json:"deviceId"`
	TargetPaths   map[string]string `json:"targetPaths,omitempty"` // original -> target path overrides
}

type AuthenticatedProviderConfig struct {
	ID             string         `json:"id"`
	Provider       string         `json:"provider"`
	ProviderConfig map[string]any `json:"providerConfig"`
}

type AuthenticatedDownloadDescriptor struct {
	Type                string `json:"type"`
	Method              string `json:"method"`
	URL                 string `json:"url"`
	TokenQueryParam     string `json:"tokenQueryParam"`
	PathQueryParam      string `json:"pathQueryParam"`
	RequiresAuthSession bool   `json:"requiresAuthentication"`
	PathPrefix          string `json:"pathPrefix"`
	ExpiresAt           string `json:"expiresAt"`
}

type AuthenticatedSnapshot struct {
	ID                  string          `json:"id"`
	SnapshotID          string          `json:"snapshotId"`
	Size                int64           `json:"size"`
	FileCount           int             `json:"fileCount"`
	HardwareProfile     json.RawMessage `json:"hardwareProfile"`
	SystemStateManifest json.RawMessage `json:"systemStateManifest"`
}

type AuthenticatedDevice struct {
	ID       string `json:"id"`
	Hostname string `json:"hostname"`
	OSType   string `json:"osType"`
}

type BootstrapResponse struct {
	Version          int                              `json:"version"`
	MinHelperVersion string                           `json:"minHelperVersion"`
	TokenID          string                           `json:"tokenId"`
	DeviceID         string                           `json:"deviceId"`
	SnapshotID       string                           `json:"snapshotId"`
	RestoreType      string                           `json:"restoreType"`
	TargetConfig     map[string]any                   `json:"targetConfig"`
	Device           *AuthenticatedDevice             `json:"device"`
	Snapshot         *AuthenticatedSnapshot           `json:"snapshot"`
	BackupConfig     *AuthenticatedProviderConfig     `json:"backupConfig"`
	Download         *AuthenticatedDownloadDescriptor `json:"download"`
	AuthenticatedAt  string                           `json:"authenticatedAt"`
}

// AuthenticateResponse is the legacy flat bootstrap payload. It remains for
// temporary fallback parsing while servers migrate to the versioned bootstrap
// envelope.
type AuthenticateResponse struct {
	TokenID         string                           `json:"tokenId"`
	DeviceID        string                           `json:"deviceId"`
	SnapshotID      string                           `json:"snapshotId"`
	RestoreType     string                           `json:"restoreType"`
	TargetConfig    map[string]any                   `json:"targetConfig"`
	Device          *AuthenticatedDevice             `json:"device"`
	Snapshot        *AuthenticatedSnapshot           `json:"snapshot"`
	BackupConfig    *AuthenticatedProviderConfig     `json:"backupConfig"`
	Download        *AuthenticatedDownloadDescriptor `json:"download"`
	AuthenticatedAt string                           `json:"authenticatedAt"`
}

// RecoveryResult tracks the outcome of a BMR operation.
type RecoveryResult struct {
	Status          string   `json:"status"` // completed, failed, partial
	FilesRestored   int      `json:"filesRestored"`
	BytesRestored   int64    `json:"bytesRestored"`
	StateApplied    bool     `json:"stateApplied"`
	DriversInjected int      `json:"driversInjected"`
	Validated       bool     `json:"validated"`
	Warnings        []string `json:"warnings,omitempty"`
	Error           string   `json:"error,omitempty"`
}

// ValidationResult from post-restore checks.
type ValidationResult struct {
	Passed          bool     `json:"passed"`
	ServicesRunning bool     `json:"servicesRunning"`
	NetworkUp       bool     `json:"networkUp"`
	CriticalFiles   bool     `json:"criticalFiles"`
	Failures        []string `json:"failures,omitempty"`
}

// VMRestoreConfig for restoring a backup as a new VM.
type VMRestoreConfig struct {
	SnapshotID string `json:"snapshotId"`
	Hypervisor string `json:"hypervisor"` // hyperv, vmware
	VMName     string `json:"vmName"`
	MemoryMB   int64  `json:"memoryMb,omitempty"`
	CPUCount   int    `json:"cpuCount,omitempty"`
	DiskSizeGB int64  `json:"diskSizeGb,omitempty"`
}

// VMEstimate returned by vm_restore_estimate command.
type VMEstimate struct {
	RecommendedMemoryMB int64  `json:"recommendedMemoryMb"`
	RecommendedCPU      int    `json:"recommendedCpu"`
	RequiredDiskGB      int64  `json:"requiredDiskGb"`
	Platform            string `json:"platform"`
	OSVersion           string `json:"osVersion"`
}

// Restorer is the platform-specific interface for applying system state
// during a bare metal recovery.
type Restorer interface {
	// RestoreSystemState applies collected system state artifacts from stagingDir.
	RestoreSystemState(stagingDir string) error
	// InjectDrivers installs drivers from the given directory.
	InjectDrivers(driverDir string) (int, error)
}
