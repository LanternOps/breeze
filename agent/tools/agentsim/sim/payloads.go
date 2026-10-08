package sim

import (
	"fmt"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/mgmtdetect"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/security"
)

// Payloads builds request bodies from the agent's own wire structs.
type Payloads struct {
	cfg *Config
	mu  sync.Mutex
	rng *rand.Rand
}

func NewPayloads(cfg *Config, rng *rand.Rand) *Payloads { return &Payloads{cfg: cfg, rng: rng} }

func (p *Payloads) between(lo, hi float64) float64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return lo + p.rng.Float64()*(hi-lo)
}

func macFor(index int) string {
	return fmt.Sprintf("02:42:%02x:%02x:%02x:%02x", byte(index>>24), byte(index>>16), byte(index>>8), byte(index))
}

func ipFor(index int) string {
	return fmt.Sprintf("10.%d.%d.%d", 64+((index>>16)&0x3f), (index>>8)&0xff, index&0xff)
}

func (p *Payloads) Heartbeat(id Identity, uptime time.Duration) heartbeat.HeartbeatPayload {
	available := true
	ram := p.between(30, 70)
	return heartbeat.HeartbeatPayload{
		Metrics: &collectors.SystemMetrics{
			CPUPercent:   p.between(2, 35),
			RAMPercent:   ram,
			RAMUsedMB:    uint64(ram / 100 * 16384),
			DiskPercent:  41.5,
			DiskUsedGB:   207.5,
			ProcessCount: 180 + int(p.between(0, 40)),
		},
		MetricsAvailable:     &available,
		Status:               "ok",
		AgentVersion:         p.cfg.AgentVersion,
		Hostname:             id.Hostname,
		OSVersion:            osVersion(p.cfg.OSType),
		UptimeSeconds:        int64(uptime / time.Second),
		IsHeadless:           true,
		SecurityCapabilities: heartbeat.CompiledSecurityCapabilities(),
	}
}

var softwareCatalog = func() []collectors.SoftwareItem {
	items := []collectors.SoftwareItem{
		{Name: "openssl", Version: "3.0.13", Vendor: "Ubuntu"},
		{Name: "openssh-server", Version: "9.6p1", Vendor: "Ubuntu"},
		{Name: "curl", Version: "8.5.0", Vendor: "Ubuntu"},
		{Name: "python3", Version: "3.12.3", Vendor: "Ubuntu"},
		{Name: "systemd", Version: "255.4", Vendor: "Ubuntu"},
		{Name: "bash", Version: "5.2.21", Vendor: "Ubuntu"},
		{Name: "coreutils", Version: "9.4", Vendor: "Ubuntu"},
		{Name: "git", Version: "2.43.0", Vendor: "Ubuntu"},
	}
	for i := len(items); i < 40; i++ {
		items = append(items, collectors.SoftwareItem{Name: fmt.Sprintf("libagentsim%02d", i), Version: fmt.Sprintf("1.0.%d", i), Vendor: "Ubuntu"})
	}
	return items
}()

func (p *Payloads) Software(now time.Time) collectors.SoftwareInventoryObservationV2 {
	items := append([]collectors.SoftwareItem(nil), softwareCatalog...)
	return collectors.SoftwareInventoryObservationV2{
		SchemaVersion:    2,
		ObservationID:    uuid.NewString(),
		CollectorVersion: "agentsim-1",
		ObservedAt:       now.UTC(),
		Completeness:     collectors.SoftwareInventoryComplete,
		ExpectedSources:  []string{"dpkg"},
		SucceededSources: []string{"dpkg"},
		FailedSources:    []collectors.SoftwareSourceFailure{},
		ItemCount:        len(items),
		Items:            items,
	}
}

func (p *Payloads) Disks() map[string]any {
	return map[string]any{"disks": []collectors.DiskInfo{{
		MountPoint: "/", Device: "/dev/sda1", FSType: "ext4",
		TotalGB: 500, UsedGB: 207.5, FreeGB: 292.5, UsedPercent: 41.5, Health: "healthy",
	}}}
}

func (p *Payloads) Network(id Identity) map[string]any {
	return map[string]any{
		"adapters": []collectors.NetworkAdapterInfo{{
			InterfaceName: "eth0", MACAddress: macFor(id.Index), IPAddress: ipFor(id.Index), IPType: "ipv4", IsPrimary: true,
		}},
		"vpns": []any{},
	}
}

// Connections mirrors heartbeat.go sendConnectionsInventory, which sends maps.
func (p *Payloads) Connections(id Identity) map[string]any {
	conns := []map[string]any{}
	for i, proc := range []string{"sshd", "breeze-agent", "systemd-resolved", "chronyd", "postgres"} {
		conns = append(conns, map[string]any{
			"protocol": "tcp", "localAddr": ipFor(id.Index), "localPort": 22 + i,
			"remoteAddr": "10.0.0.1", "remotePort": 40000 + i, "state": "ESTABLISHED",
			"pid": 800 + i, "processName": proc,
		})
	}
	return map[string]any{"connections": conns}
}

func (p *Payloads) RegistryState() map[string]any {
	return map[string]any{"entries": []any{}, "replace": true}
}

func (p *Payloads) ConfigState() map[string]any {
	return map[string]any{"entries": []any{}, "replace": true}
}

// Sessions mirrors heartbeat.go sendSessionInventory.
func (p *Payloads) Sessions(now time.Time) map[string]any {
	uid := uint32(1000)
	idle := 3
	return map[string]any{
		"sessions": []collectors.UserSession{{
			Username: "simuser", SessionType: "ssh", SessionID: "1",
			LoginAt: now.Add(-2 * time.Hour).UTC(), IdleMinutes: &idle, ActivityState: "active",
			IsActive: true, LastActivityAt: now.Add(-3 * time.Minute).UTC(),
			Principal: &collectors.SessionPrincipal{UID: &uid, Username: "simuser"},
		}},
		"events":      []collectors.UserSessionEvent{},
		"collectedAt": now.UTC(),
	}
}

func (p *Payloads) Security(id Identity) security.SecurityStatus {
	return security.SecurityStatus{
		DeviceID: id.DeviceID, DeviceName: id.Hostname, OrgID: id.OrgID, OS: p.cfg.OSType,
		Provider: "none", FirewallEnabled: true, EncryptionStatus: "encrypted",
	}
}

func (p *Payloads) Posture(now time.Time) mgmtdetect.ManagementPosture {
	return mgmtdetect.ManagementPosture{
		CollectedAt:    now.UTC(),
		ScanDurationMs: 420,
		Categories:     map[mgmtdetect.Category][]mgmtdetect.Detection{},
		Identity:       mgmtdetect.IdentityStatus{JoinType: mgmtdetect.JoinTypeNone, Source: "agentsim"},
	}
}

func (p *Payloads) EventLogs(now time.Time) map[string]any {
	events := make([]collectors.EventLogEntry, 0, 3)
	for i := 0; i < 3; i++ {
		events = append(events, collectors.EventLogEntry{
			Timestamp: now.Add(-time.Duration(i) * time.Minute).UTC().Format(time.RFC3339),
			Level:     "info", Category: "system", Source: "systemd",
			EventID: fmt.Sprint(1000 + i), Message: "agentsim: periodic system event",
		})
	}
	return map[string]any{"events": events}
}

// ProcessSample mirrors heartbeat.go sendProcessSample (top-N union, ≤ 16).
func (p *Payloads) ProcessSample(now time.Time) map[string]any {
	names := []string{"breeze-agent", "sshd", "systemd", "postgres", "node", "dockerd", "containerd", "chronyd"}
	procs := make([]tools.ProcessSampleEntry, 0, len(names))
	for i, n := range names {
		procs = append(procs, tools.ProcessSampleEntry{Name: n, PID: int32(100 + i), CPU: p.between(0, 5), RAMMb: p.between(10, 400)})
	}
	return map[string]any{"timestamp": now.UTC().Format(time.RFC3339), "processes": procs}
}
