// Package workloads inventories what a host runs: containers today, virtual
// machines in later drivers. Collection is read-only by construction (see
// transport.go) and reports only the fields listed in the field allowlist.
package workloads

import (
	"context"
	"unicode/utf8"
)

// ProtocolVersion is the wire protocol this build speaks. It is also declared
// as SecurityCapabilities.WorkloadInventoryProtocolVersion on every heartbeat.
const ProtocolVersion = 1

// Runtime names a workload runtime. The strings are wire values.
type Runtime string

const (
	RuntimeDocker     Runtime = "docker"
	RuntimePodman     Runtime = "podman"
	RuntimeHyperV     Runtime = "hyperv"
	RuntimeProxmox    Runtime = "proxmox"
	RuntimeContainerd Runtime = "containerd"
)

// Detection states (wire values).
const (
	DetectionPresent = "present"
	DetectionAbsent  = "absent"
	DetectionUnknown = "unknown"
)

// Collection states (wire values).
const (
	CollectionOK               = "ok"
	CollectionDisabled         = "disabled"
	CollectionUnavailable      = "unavailable"
	CollectionPermissionDenied = "permission_denied"
	CollectionError            = "error"
	CollectionUnsupported      = "unsupported"
)

// Detection.Reason codes. A present runtime that cannot be enumerated right
// now carries ReasonPermissionDenied or ReasonUnavailable so Collect can report
// the right collection state without a second round trip.
const (
	ReasonPermissionDenied = "permission_denied"
	ReasonUnavailable      = "unavailable"
	ReasonNotRunning       = "not_running"
	ReasonTimeout          = "timeout"
	ReasonUnreachable      = "unreachable"
	ReasonPanic            = "panic"
)

// Workload kinds and states (wire values).
const (
	KindContainer = "container"
	KindVM        = "vm"
	KindLXC       = "lxc"

	StateRunning    = "running"
	StateStopped    = "stopped"
	StatePaused     = "paused"
	StateRestarting = "restarting"
	StateOther      = "other"
)

const (
	// MaxWorkloadsPerRuntime is the per-runtime cap on reported workloads.
	MaxWorkloadsPerRuntime = 1000
	// MaxErrorLen bounds the error string on the wire.
	MaxErrorLen = 500
	// MaxPayloadBytes keeps the serialized report below 1.75 MB; the API body limit is 2 MB.
	MaxPayloadBytes = 1_750_000
)

// Detection is the cheap, always-run answer to "does this host run runtime X".
// It never lists workloads.
type Detection struct {
	State   string // DetectionPresent | DetectionAbsent | DetectionUnknown
	Version string
	Reason  string // machine code, see the Reason* constants; empty when none
}

// Result is what a driver returns from Collect.
type Result struct {
	Collection    string // one of the Collection* values except CollectionDisabled
	Complete      bool
	Workloads     []Workload
	ObservedCount int
	Error         string // short machine code, never raw runtime output
}

// Driver is one workload runtime. Implementations must be read-only.
type Driver interface {
	Runtime() Runtime
	Detect(ctx context.Context) Detection
	Collect(ctx context.Context, d Detection) Result
}

// Workload is one container, VM or LXC guest, using exactly the wire field
// names. Every nullable field is a pointer and is always emitted (null when
// unknown); the server rejects unknown keys, so this struct is the allowlist.
type Workload struct {
	WorkloadID        string  `json:"workloadId"`
	Kind              string  `json:"kind"`
	Name              string  `json:"name"`
	State             string  `json:"state"`
	RawState          *string `json:"rawState"`
	ImageRef          *string `json:"imageRef"`
	ImageRepository   *string `json:"imageRepository"`
	ImageTag          *string `json:"imageTag"`
	ImageDigest       *string `json:"imageDigest"`
	ImageID           *string `json:"imageId"`
	GuestOS           *string `json:"guestOs"`
	ComposeProject    *string `json:"composeProject"`
	ComposeService    *string `json:"composeService"`
	ComposeWorkingDir *string `json:"composeWorkingDir"`
	RestartPolicy     *string `json:"restartPolicy"`
	CPUCount          *int    `json:"cpuCount"`
	MemoryMB          *int    `json:"memoryMb"`
	StartedAt         *string `json:"startedAt"`
	RuntimeCreatedAt  *string `json:"runtimeCreatedAt"`
}

// RuntimeReport is one entry of Report.Runtimes.
type RuntimeReport struct {
	Runtime        Runtime    `json:"runtime"`
	Detection      string     `json:"detection"`
	Collection     string     `json:"collection"`
	Complete       bool       `json:"complete"`
	RuntimeVersion *string    `json:"runtimeVersion"`
	ObservedCount  int        `json:"observedCount"`
	Error          *string    `json:"error"`
	Workloads      []Workload `json:"workloads"`
}

// Report is the body of PUT /api/v1/agents/{agentID}/workloads.
type Report struct {
	ProtocolVersion int             `json:"protocolVersion"`
	CollectedAt     string          `json:"collectedAt"`
	Runtimes        []RuntimeReport `json:"runtimes"`
}

// Settings is the agent's view of workload_inventory_settings.
type Settings struct {
	Enabled         bool
	Docker          bool
	Podman          bool
	HyperV          bool
	Proxmox         bool
	IntervalMinutes int
}

// RuntimeEnabled reports whether the driver for r may run Collect. containerd
// has no per-runtime switch; it follows the master switch and its driver
// answers "unsupported" in v1.
func (s Settings) RuntimeEnabled(r Runtime) bool {
	if !s.Enabled {
		return false
	}
	switch r {
	case RuntimeDocker:
		return s.Docker
	case RuntimePodman:
		return s.Podman
	case RuntimeHyperV:
		return s.HyperV
	case RuntimeProxmox:
		return s.Proxmox
	case RuntimeContainerd:
		return true
	}
	return false
}

// DefaultSettings is the in-memory state before the first configUpdate:
// detection runs, enumeration is off.
func DefaultSettings() Settings {
	return Settings{Docker: true, Podman: true, HyperV: true, Proxmox: true, IntervalMinutes: 60}
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// clip truncates s to at most max bytes on a rune boundary. Bytes are at least
// as many as characters or UTF-16 units, so a clipped value satisfies any
// server-side length bound of the same number.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

func clipPtr(p *string, max int) *string {
	if p == nil {
		return nil
	}
	return strp(clip(*p, max))
}

// Bound enforces the column bounds from the ingest contract so one oversized
// label can never make the server reject a whole report.
func (w *Workload) Bound() {
	w.WorkloadID = clip(w.WorkloadID, 128)
	w.Name = clip(w.Name, 255)
	w.RawState = clipPtr(w.RawState, 40)
	w.ImageRef = clipPtr(w.ImageRef, 512)
	w.ImageRepository = clipPtr(w.ImageRepository, 400)
	w.ImageTag = clipPtr(w.ImageTag, 128)
	w.ImageDigest = clipPtr(w.ImageDigest, 80)
	w.ImageID = clipPtr(w.ImageID, 80)
	w.GuestOS = clipPtr(w.GuestOS, 128)
	w.ComposeProject = clipPtr(w.ComposeProject, 128)
	w.ComposeService = clipPtr(w.ComposeService, 128)
	w.ComposeWorkingDir = clipPtr(w.ComposeWorkingDir, 512)
	w.RestartPolicy = clipPtr(w.RestartPolicy, 30)
}
