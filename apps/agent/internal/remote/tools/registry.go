// Package tools provides remote management tools for the agent.
package tools

import (
	"sync"
)

// RegistryKey represents a Windows registry key.
type RegistryKey struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	SubKeyCount int    `json:"subKeyCount"`
	ValueCount  int    `json:"valueCount"`
}

// RegistryValue represents a Windows registry value.
type RegistryValue struct {
	Name     string      `json:"name"`
	Type     string      `json:"type"` // REG_SZ, REG_DWORD, REG_BINARY, REG_MULTI_SZ, REG_EXPAND_SZ, REG_QWORD
	Data     interface{} `json:"data"`
	DataSize int         `json:"dataSize"`
}

// RegistryManager provides safe access to the Windows registry.
type RegistryManager struct {
	mu sync.Mutex
}

// NewRegistryManager creates a new RegistryManager instance.
func NewRegistryManager() *RegistryManager {
	return &RegistryManager{}
}

// Registry value type constants.
const (
	RegSZ        = "REG_SZ"
	RegExpandSZ  = "REG_EXPAND_SZ"
	RegBinary    = "REG_BINARY"
	RegDWORD     = "REG_DWORD"
	RegMultiSZ   = "REG_MULTI_SZ"
	RegQWORD     = "REG_QWORD"
	RegNone      = "REG_NONE"
	RegFullResourceDescriptor = "REG_FULL_RESOURCE_DESCRIPTOR"
	RegResourceList = "REG_RESOURCE_LIST"
	RegResourceRequirementsList = "REG_RESOURCE_REQUIREMENTS_LIST"
)

// Supported registry hives.
const (
	HiveLocalMachine  = "HKEY_LOCAL_MACHINE"
	HiveCurrentUser   = "HKEY_CURRENT_USER"
	HiveClassesRoot   = "HKEY_CLASSES_ROOT"
	HiveUsers         = "HKEY_USERS"
	HiveCurrentConfig = "HKEY_CURRENT_CONFIG"
)

// Critical registry paths that should not be modified.
var criticalPaths = []string{
	"SYSTEM\\CurrentControlSet\\Control\\Session Manager",
	"SYSTEM\\CurrentControlSet\\Control\\Lsa",
	"SYSTEM\\CurrentControlSet\\Services\\Tcpip",
	"SYSTEM\\CurrentControlSet\\Services\\LanmanServer",
	"SYSTEM\\CurrentControlSet\\Services\\LanmanWorkstation",
	"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon",
	"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System",
	"SOFTWARE\\Microsoft\\Cryptography",
	"SAM",
	"SECURITY",
}

// Critical registry values that should not be modified.
var criticalValues = map[string][]string{
	"SYSTEM\\CurrentControlSet\\Control\\Session Manager": {
		"BootExecute",
		"PendingFileRenameOperations",
	},
	"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon": {
		"Shell",
		"Userinit",
	},
}
