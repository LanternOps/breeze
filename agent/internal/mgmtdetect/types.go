package mgmtdetect

import (
	"slices"
	"time"
)

// DetectionStatus represents the status of a detected management tool.
type DetectionStatus string

// Detection status constants.
const (
	StatusActive    DetectionStatus = "active"
	StatusInstalled DetectionStatus = "installed"
	StatusUnknown   DetectionStatus = "unknown"
)

// Category represents a management tool category.
type Category string

// Category constants.
const (
	CategoryMDM              Category = "mdm"
	CategoryRMM              Category = "rmm"
	CategoryRemoteAccess     Category = "remoteAccess"
	CategoryEndpointSecurity Category = "endpointSecurity"
	CategoryPolicyEngine     Category = "policyEngine"
	CategoryBackup           Category = "backup"
	CategoryIdentityMFA      Category = "identityMfa"
	CategorySIEM             Category = "siem"
	CategoryDNSFiltering     Category = "dnsFiltering"
	CategoryZeroTrustVPN     Category = "zeroTrustVpn"
	CategoryPatchManagement  Category = "patchManagement"
)

// JoinType represents the device's directory join type.
type JoinType string

const (
	JoinTypeHybridAzureAD JoinType = "hybrid_azure_ad"
	JoinTypeAzureAD       JoinType = "azure_ad"
	JoinTypeOnPremAD      JoinType = "on_prem_ad"
	JoinTypeWorkplace     JoinType = "workplace"
	JoinTypeNone          JoinType = "none"
)

// CheckType identifies the kind of system check to perform.
type CheckType string

const (
	CheckFileExists     CheckType = "file_exists"
	CheckServiceRunning CheckType = "service_running"
	CheckProcessRunning CheckType = "process_running"
	CheckRegistryValue  CheckType = "registry_value"
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
	Category Category `json:"category"`
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
	Name        string          `json:"name"`
	Version     string          `json:"version,omitempty"`
	Status      DetectionStatus `json:"status"`
	ServiceName string          `json:"serviceName,omitempty"`
	Details     any             `json:"details,omitempty"`
}

// IdentityStatus describes the device's directory/join posture.
type IdentityStatus struct {
	JoinType        JoinType `json:"joinType"`
	AzureAdJoined   bool     `json:"azureAdJoined"`
	DomainJoined    bool     `json:"domainJoined"`
	WorkplaceJoined bool     `json:"workplaceJoined"`
	DomainName      string   `json:"domainName,omitempty"`
	TenantId        string   `json:"tenantId,omitempty"`
	MdmUrl          string   `json:"mdmUrl,omitempty"`
	Source          string   `json:"source"`
}

// ManagementPosture is the top-level result of a posture scan.
type ManagementPosture struct {
	CollectedAt    time.Time                `json:"collectedAt"`
	ScanDurationMs int64                    `json:"scanDurationMs"`
	Categories     map[Category][]Detection `json:"categories"`
	Identity       IdentityStatus           `json:"identity"`
	Errors         []string                 `json:"errors,omitempty"`
}
