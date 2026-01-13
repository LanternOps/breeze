package models

import "time"

// DeviceInfo represents the device registration data
type DeviceInfo struct {
	ID           string            `json:"id,omitempty"`
	Hostname     string            `json:"hostname"`
	OS           string            `json:"os"`
	OSVersion    string            `json:"osVersion"`
	Architecture string            `json:"architecture"`
	AgentVersion string            `json:"agentVersion"`
	Tags         map[string]string `json:"tags,omitempty"`
}

// HardwareInfo represents collected hardware information
type HardwareInfo struct {
	CPU        CPUInfo       `json:"cpu"`
	Memory     MemoryInfo    `json:"memory"`
	Disks      []DiskInfo    `json:"disks"`
	Network    []NetworkInfo `json:"network"`
	BIOS       BIOSInfo      `json:"bios,omitempty"`
	Motherboard string       `json:"motherboard,omitempty"`
}

// CPUInfo represents CPU details
type CPUInfo struct {
	Model       string `json:"model"`
	Cores       int    `json:"cores"`
	Threads     int    `json:"threads"`
	BaseSpeed   uint64 `json:"baseSpeed"` // MHz
	Vendor      string `json:"vendor"`
	Family      string `json:"family,omitempty"`
}

// MemoryInfo represents memory details
type MemoryInfo struct {
	Total     uint64 `json:"total"`     // bytes
	Available uint64 `json:"available"` // bytes
	Used      uint64 `json:"used"`      // bytes
	UsedPct   float64 `json:"usedPct"`
	SwapTotal uint64 `json:"swapTotal"`
	SwapUsed  uint64 `json:"swapUsed"`
}

// DiskInfo represents disk details
type DiskInfo struct {
	Device     string  `json:"device"`
	MountPoint string  `json:"mountPoint"`
	FSType     string  `json:"fsType"`
	Total      uint64  `json:"total"`
	Used       uint64  `json:"used"`
	Free       uint64  `json:"free"`
	UsedPct    float64 `json:"usedPct"`
}

// NetworkInfo represents network interface details
type NetworkInfo struct {
	Name       string   `json:"name"`
	MAC        string   `json:"mac"`
	IPs        []string `json:"ips"`
	Speed      uint64   `json:"speed,omitempty"` // Mbps
	IsUp       bool     `json:"isUp"`
	IsLoopback bool     `json:"isLoopback"`
}

// BIOSInfo represents BIOS details
type BIOSInfo struct {
	Vendor  string `json:"vendor"`
	Version string `json:"version"`
	Date    string `json:"date,omitempty"`
}

// SoftwareInfo represents installed software
type SoftwareInfo struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Publisher   string `json:"publisher,omitempty"`
	InstallDate string `json:"installDate,omitempty"`
	InstallPath string `json:"installPath,omitempty"`
	Size        uint64 `json:"size,omitempty"` // bytes
}

// Metrics represents real-time system metrics
type Metrics struct {
	Timestamp  time.Time      `json:"timestamp"`
	CPU        CPUMetrics     `json:"cpu"`
	Memory     MemoryMetrics  `json:"memory"`
	Disks      []DiskMetrics  `json:"disks"`
	Network    NetworkMetrics `json:"network"`
	Processes  int            `json:"processes"`
	LoadAvg    []float64      `json:"loadAvg,omitempty"` // 1, 5, 15 min
}

// CPUMetrics represents CPU utilization
type CPUMetrics struct {
	UsedPct    float64   `json:"usedPct"`
	UserPct    float64   `json:"userPct"`
	SystemPct  float64   `json:"systemPct"`
	IdlePct    float64   `json:"idlePct"`
	PerCore    []float64 `json:"perCore,omitempty"`
}

// MemoryMetrics represents memory utilization
type MemoryMetrics struct {
	UsedPct     float64 `json:"usedPct"`
	Available   uint64  `json:"available"`
	SwapUsedPct float64 `json:"swapUsedPct,omitempty"`
}

// DiskMetrics represents disk I/O metrics
type DiskMetrics struct {
	Device     string  `json:"device"`
	UsedPct    float64 `json:"usedPct"`
	ReadBytes  uint64  `json:"readBytes"`
	WriteBytes uint64  `json:"writeBytes"`
	ReadOps    uint64  `json:"readOps"`
	WriteOps   uint64  `json:"writeOps"`
}

// NetworkMetrics represents network I/O metrics
type NetworkMetrics struct {
	BytesSent   uint64 `json:"bytesSent"`
	BytesRecv   uint64 `json:"bytesRecv"`
	PacketsSent uint64 `json:"packetsSent"`
	PacketsRecv uint64 `json:"packetsRecv"`
	Errors      uint64 `json:"errors"`
}

// HeartbeatRequest is sent to the server periodically
type HeartbeatRequest struct {
	DeviceID     string   `json:"deviceId"`
	AgentVersion string   `json:"agentVersion"`
	Uptime       int64    `json:"uptime"` // seconds
	Metrics      *Metrics `json:"metrics,omitempty"`
}

// HeartbeatResponse contains commands from the server
type HeartbeatResponse struct {
	Status       string        `json:"status"`
	Commands     []Command     `json:"commands,omitempty"`
	ConfigUpdate *ConfigUpdate `json:"configUpdate,omitempty"`
}

// Command represents a command to execute
type Command struct {
	ID       string                 `json:"id"`
	Type     string                 `json:"type"` // script, action, update
	Payload  map[string]interface{} `json:"payload"`
	Priority int                    `json:"priority"`
}

// ConfigUpdate represents configuration changes from server
type ConfigUpdate struct {
	HeartbeatInterval *int  `json:"heartbeatInterval,omitempty"`
	MetricsInterval   *int  `json:"metricsInterval,omitempty"`
	EnableMetrics     *bool `json:"enableMetrics,omitempty"`
	EnableRemote      *bool `json:"enableRemote,omitempty"`
}

// EnrollmentRequest is sent when enrolling a new device
type EnrollmentRequest struct {
	EnrollmentKey string     `json:"enrollmentKey"`
	Device        DeviceInfo `json:"device"`
	Hardware      HardwareInfo `json:"hardware"`
}

// EnrollmentResponse is returned after successful enrollment
type EnrollmentResponse struct {
	DeviceID string `json:"deviceId"`
	APIKey   string `json:"apiKey"`
	OrgID    string `json:"orgId"`
	SiteID   string `json:"siteId,omitempty"`
}

// ScriptExecution represents a script to run
type ScriptExecution struct {
	ID         string            `json:"id"`
	ScriptID   string            `json:"scriptId"`
	Script     string            `json:"script"`
	ScriptType string            `json:"scriptType"` // powershell, bash, python, cmd
	Parameters map[string]string `json:"parameters,omitempty"`
	Timeout    int               `json:"timeout"` // seconds
	RunAs      string            `json:"runAs,omitempty"`
}

// ScriptResult represents the result of a script execution
type ScriptResult struct {
	ExecutionID string `json:"executionId"`
	ExitCode    int    `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	StartedAt   string `json:"startedAt"`
	CompletedAt string `json:"completedAt"`
	Error       string `json:"error,omitempty"`
}
