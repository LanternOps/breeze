package tools

import (
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// EvidenceProcessInfo captures a process snapshot for incident evidence.
type EvidenceProcessInfo struct {
	PID        int32   `json:"pid"`
	Name       string  `json:"name"`
	CmdLine    string  `json:"cmdline"`
	User       string  `json:"user"`
	CreateTime int64   `json:"createTime"`
	CPUPercent float64 `json:"cpuPercent"`
	RSS        uint64  `json:"rss"`
}

// EvidenceConnectionInfo captures a network connection for incident evidence.
type EvidenceConnectionInfo struct {
	Type       string `json:"type"`
	Status     string `json:"status"`
	LocalAddr  string `json:"localAddr"`
	LocalPort  uint32 `json:"localPort"`
	RemoteAddr string `json:"remoteAddr"`
	RemotePort uint32 `json:"remotePort"`
	PID        int32  `json:"pid"`
}

// CollectEvidence gathers forensic evidence from the device.
// Supported evidence types: "processes", "connections", "logs".
func CollectEvidence(payload map[string]any) CommandResult {
	startTime := time.Now()

	evidenceTypes := GetPayloadStringSlice(payload, "evidenceTypes")
	if len(evidenceTypes) == 0 {
		evidenceTypes = []string{"processes", "connections", "logs"}
	}

	evidence := make(map[string]any)

	for _, et := range evidenceTypes {
		switch et {
		case "processes":
			data, err := collectProcessEvidence()
			if err != nil {
				evidence["processes"] = map[string]any{
					"error": err.Error(),
				}
			} else {
				evidence["processes"] = data
			}

		case "connections":
			data, err := collectConnectionEvidence()
			if err != nil {
				evidence["connections"] = map[string]any{
					"error": err.Error(),
				}
			} else {
				evidence["connections"] = data
			}

		case "logs":
			evidence["logs"] = map[string]any{
				"message":  "full log collection requires platform-specific implementation",
				"platform": runtime.GOOS,
			}

		case "screenshot":
			evidence[et] = map[string]any{
				"note":      "Screenshot evidence collection requires platform-specific implementation",
				"collected": false,
			}

		default:
			evidence[et] = map[string]any{
				"error": fmt.Sprintf("unknown evidence type: %s", et),
			}
		}
	}

	result := map[string]any{
		"evidence":      evidence,
		"collectedAt":   time.Now().UTC().Format(time.RFC3339),
		"evidenceTypes": evidenceTypes,
		"platform":      runtime.GOOS,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

// collectProcessEvidence snapshots all running processes.
func collectProcessEvidence() ([]EvidenceProcessInfo, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, fmt.Errorf("failed to list processes: %w", err)
	}

	infos := make([]EvidenceProcessInfo, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil {
			continue
		}

		info := EvidenceProcessInfo{
			PID:  p.Pid,
			Name: name,
		}

		if cmdline, err := p.Cmdline(); err == nil {
			info.CmdLine = cmdline
		}
		if user, err := p.Username(); err == nil {
			info.User = user
		}
		if ct, err := p.CreateTime(); err == nil {
			info.CreateTime = ct
		}
		if cpu, err := p.CPUPercent(); err == nil {
			info.CPUPercent = cpu
		}
		if mem, err := p.MemoryInfo(); err == nil && mem != nil {
			info.RSS = mem.RSS
		}

		infos = append(infos, info)
	}

	return infos, nil
}

// collectConnectionEvidence snapshots all network connections.
func collectConnectionEvidence() ([]EvidenceConnectionInfo, error) {
	conns, err := net.Connections("all")
	if err != nil {
		return nil, fmt.Errorf("failed to list connections: %w", err)
	}

	infos := make([]EvidenceConnectionInfo, 0, len(conns))
	for _, c := range conns {
		connType := "unknown"
		switch c.Type {
		case 1:
			connType = "tcp"
		case 2:
			connType = "udp"
		}

		infos = append(infos, EvidenceConnectionInfo{
			Type:       connType,
			Status:     c.Status,
			LocalAddr:  c.Laddr.IP,
			LocalPort:  c.Laddr.Port,
			RemoteAddr: c.Raddr.IP,
			RemotePort: c.Raddr.Port,
			PID:        c.Pid,
		})
	}

	return infos, nil
}

// ExecuteContainment performs a containment action on the device.
// Supported actions: "process_kill", "network_isolation", "account_disable", "usb_block".
func ExecuteContainment(payload map[string]any) CommandResult {
	startTime := time.Now()

	actionType, errResult := RequirePayloadString(payload, "actionType")
	if errResult != nil {
		errResult.DurationMs = time.Since(startTime).Milliseconds()
		return *errResult
	}

	switch actionType {
	case "process_kill":
		return executeProcessKill(payload, startTime)

	case "network_isolation":
		return NewErrorResult(
			fmt.Errorf("network_isolation requires platform-specific implementation (current: %s)", runtime.GOOS),
			time.Since(startTime).Milliseconds(),
		)

	case "account_disable":
		return NewErrorResult(
			fmt.Errorf("account_disable requires platform-specific implementation (current: %s)", runtime.GOOS),
			time.Since(startTime).Milliseconds(),
		)

	case "usb_block":
		return NewErrorResult(
			fmt.Errorf("usb_block requires platform-specific implementation (current: %s)", runtime.GOOS),
			time.Since(startTime).Milliseconds(),
		)

	default:
		return NewErrorResult(
			fmt.Errorf("unsupported containment action: %s", actionType),
			time.Since(startTime).Milliseconds(),
		)
	}
}

// executeProcessKill kills a process by PID as a containment action.
func executeProcessKill(payload map[string]any, startTime time.Time) CommandResult {
	params, ok := payload["parameters"].(map[string]any)
	if !ok {
		return NewErrorResult(
			fmt.Errorf("parameters map is required for process_kill"),
			time.Since(startTime).Milliseconds(),
		)
	}

	pid := GetPayloadInt(params, "pid", 0)
	if pid == 0 {
		return NewErrorResult(
			fmt.Errorf("pid is required in parameters"),
			time.Since(startTime).Milliseconds(),
		)
	}

	// Guard against killing critical system processes
	if pid <= 1 {
		return NewErrorResult(fmt.Errorf("cannot kill PID %d: system-critical process", pid), time.Since(startTime).Milliseconds())
	}

	// Guard against killing the agent itself
	if pid == os.Getpid() {
		return NewErrorResult(fmt.Errorf("cannot kill PID %d: this is the agent process", pid), time.Since(startTime).Milliseconds())
	}

	p, err := process.NewProcess(int32(pid))
	if err != nil {
		return NewErrorResult(
			fmt.Errorf("process not found (pid %d): %w", pid, err),
			time.Since(startTime).Milliseconds(),
		)
	}

	name, _ := p.Name()

	if err := p.Kill(); err != nil {
		return NewErrorResult(
			fmt.Errorf("failed to kill process %d (%s): %w", pid, name, err),
			time.Since(startTime).Milliseconds(),
		)
	}

	return NewSuccessResult(map[string]any{
		"actionType": "process_kill",
		"pid":        pid,
		"name":       name,
		"killed":     true,
	}, time.Since(startTime).Milliseconds())
}
