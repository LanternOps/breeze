package mgmtdetect

import (
	"slices"
	"time"
)

// Detection status constants.
const (
	StatusActive    = "active"
	StatusInstalled = "installed"
	StatusUnknown   = "unknown"
)

// Category constants.
const (
	CategoryMDM              = "mdm"
	CategoryRMM              = "rmm"
	CategoryRemoteAccess     = "remoteAccess"
	CategoryEndpointSecurity = "endpointSecurity"
	CategoryPolicyEngine     = "policyEngine"
	CategoryBackup           = "backup"
	CategoryIdentityMFA      = "identityMfa"
	CategorySIEM             = "siem"
	CategoryDNSFiltering     = "dnsFiltering"
	CategoryZeroTrustVPN     = "zeroTrustVpn"
	CategoryPatchManagement  = "patchManagement"
)

// CheckType identifies the kind of system check to perform.
type CheckType string

const (
	CheckFileExists     CheckType = "file_exists"
	CheckServiceRunning CheckType = "service_running"
	CheckProcessRunning CheckType = "process_running"
	CheckRegistryValue  CheckType = "registry_value"
	CheckConfigValue    CheckType = "config_value"
	CheckCommand        CheckType = "command"
	CheckLaunchDaemon   CheckType = "launch_daemon"
)

// Check defines a single detection probe.
type Check struct {
	Type  CheckType `json:"type"`
	Value string    `json:"value"`
	Parse string    `json:"parse,omitempty"`
	OS    string    `json:"os,omitempty"`
}

// Signature defines how to detect a specific management tool.
type Signature struct {
	Name     string   `json:"name"`
	Category string   `json:"category"`
	OS       []string `json:"os"`
	Checks   []Check  `json:"checks"`
	Version  *Check   `json:"version,omitempty"`
}

// MatchesOS returns true if the signature applies to the given GOOS value.
func (s Signature) MatchesOS(goos string) bool {
	return slices.Contains(s.OS, goos)
}

// Detection represents a detected management tool on a device.
type Detection struct {
	Name        string `json:"name"`
	Version     string `json:"version,omitempty"`
	Status      string `json:"status"`
	ServiceName string `json:"serviceName,omitempty"`
	Details     any    `json:"details,omitempty"`
}

// IdentityStatus describes the device's directory/join posture.
type IdentityStatus struct {
	JoinType        string `json:"joinType"`
	AzureAdJoined   bool   `json:"azureAdJoined"`
	DomainJoined    bool   `json:"domainJoined"`
	WorkplaceJoined bool   `json:"workplaceJoined"`
	DomainName      string `json:"domainName,omitempty"`
	TenantId        string `json:"tenantId,omitempty"`
	MdmUrl          string `json:"mdmUrl,omitempty"`
	Source          string `json:"source"`
}

// ManagementPosture is the top-level result of a posture scan.
type ManagementPosture struct {
	CollectedAt    time.Time              `json:"collectedAt"`
	ScanDurationMs int64                  `json:"scanDurationMs"`
	Categories     map[string][]Detection `json:"categories"`
	Identity       IdentityStatus         `json:"identity"`
	Errors         []string               `json:"errors,omitempty"`
}
