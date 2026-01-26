//go:build darwin

package collectors

import (
	"bufio"
	"os/exec"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// Collect gathers all active network connections on macOS
func (c *ConnectionsCollector) Collect() ([]ConnectionInfo, error) {
	// Try gopsutil first
	connections, err := c.collectWithGopsutil()
	if err == nil && len(connections) > 0 {
		return connections, nil
	}

	// Fallback to netstat parsing if gopsutil fails
	return c.collectWithNetstat()
}

// collectWithGopsutil uses gopsutil library for connection data
func (c *ConnectionsCollector) collectWithGopsutil() ([]ConnectionInfo, error) {
	// Get all TCP and UDP connections
	conns, err := net.Connections("all")
	if err != nil {
		return nil, err
	}

	var connections []ConnectionInfo
	processCache := make(map[int32]string)

	for _, conn := range conns {
		// Skip connections without local address
		if conn.Laddr.IP == "" {
			continue
		}

		// Determine protocol string
		protocol := c.getProtocolString(conn.Type, conn.Family)

		// Get process name if we have a PID
		processName := ""
		if conn.Pid > 0 {
			if cached, ok := processCache[conn.Pid]; ok {
				processName = cached
			} else {
				if proc, err := process.NewProcess(conn.Pid); err == nil {
					if name, err := proc.Name(); err == nil {
						processName = name
						processCache[conn.Pid] = name
					}
				}
			}
		}

		connections = append(connections, ConnectionInfo{
			Protocol:    protocol,
			LocalAddr:   conn.Laddr.IP,
			LocalPort:   int(conn.Laddr.Port),
			RemoteAddr:  conn.Raddr.IP,
			RemotePort:  int(conn.Raddr.Port),
			State:       conn.Status,
			Pid:         int(conn.Pid),
			ProcessName: processName,
		})
	}

	return connections, nil
}

// getProtocolString converts gopsutil type/family to protocol string
func (c *ConnectionsCollector) getProtocolString(connType uint32, family uint32) string {
	// Type: 1=TCP, 2=UDP
	// Family: 2=IPv4, 10/30=IPv6 (10 on Linux, 30 on macOS)
	isIPv6 := family == 10 || family == 30

	switch connType {
	case 1: // TCP
		if isIPv6 {
			return "tcp6"
		}
		return "tcp"
	case 2: // UDP
		if isIPv6 {
			return "udp6"
		}
		return "udp"
	default:
		return "unknown"
	}
}

// collectWithNetstat parses netstat output as fallback
func (c *ConnectionsCollector) collectWithNetstat() ([]ConnectionInfo, error) {
	// Run netstat -anv to get all connections with process info
	cmd := exec.Command("netstat", "-anv", "-p", "tcp")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	connections := c.parseNetstatOutput(string(output), "tcp")

	// Also get UDP connections
	cmd = exec.Command("netstat", "-anv", "-p", "udp")
	output, err = cmd.Output()
	if err == nil {
		connections = append(connections, c.parseNetstatOutput(string(output), "udp")...)
	}

	return connections, nil
}

// parseNetstatOutput parses netstat -anv output
func (c *ConnectionsCollector) parseNetstatOutput(output string, protocol string) []ConnectionInfo {
	var connections []ConnectionInfo
	scanner := bufio.NewScanner(strings.NewReader(output))

	for scanner.Scan() {
		line := scanner.Text()
		// Skip header lines
		if strings.HasPrefix(line, "Active") || strings.HasPrefix(line, "Proto") || strings.TrimSpace(line) == "" {
			continue
		}

		conn := c.parseNetstatLine(line, protocol)
		if conn != nil {
			connections = append(connections, *conn)
		}
	}

	return connections
}

// parseNetstatLine parses a single netstat line
func (c *ConnectionsCollector) parseNetstatLine(line string, protocol string) *ConnectionInfo {
	fields := strings.Fields(line)
	if len(fields) < 5 {
		return nil
	}

	// Detect IPv6 based on protocol field
	proto := fields[0]
	isIPv6 := strings.Contains(proto, "6") || strings.Contains(proto, "46")

	if isIPv6 {
		protocol = protocol + "6"
	}

	// Parse local address (field index varies)
	localAddr, localPort := c.parseAddress(fields[3])
	remoteAddr, remotePort := c.parseAddress(fields[4])

	// State is typically field 5 for TCP
	state := ""
	if protocol == "tcp" || protocol == "tcp6" {
		if len(fields) > 5 {
			state = fields[5]
		}
	}

	// Try to get PID from last field (format varies)
	pid := 0
	if len(fields) > 8 {
		// The PID might be in the last few fields
		for i := len(fields) - 1; i >= 6; i-- {
			if p, err := strconv.Atoi(fields[i]); err == nil && p > 0 {
				pid = p
				break
			}
		}
	}

	return &ConnectionInfo{
		Protocol:   protocol,
		LocalAddr:  localAddr,
		LocalPort:  localPort,
		RemoteAddr: remoteAddr,
		RemotePort: remotePort,
		State:      state,
		Pid:        pid,
	}
}

// parseAddress splits an address:port string
func (c *ConnectionsCollector) parseAddress(addr string) (string, int) {
	// Handle IPv6 addresses like [::1].port or ::1.port
	if strings.HasPrefix(addr, "[") {
		// IPv6 format: [addr].port
		if idx := strings.LastIndex(addr, "]."); idx != -1 {
			ip := addr[1:idx]
			port, _ := strconv.Atoi(addr[idx+2:])
			return ip, port
		}
	}

	// Handle regular format: addr.port (note: netstat uses . not :)
	if idx := strings.LastIndex(addr, "."); idx != -1 {
		ip := addr[:idx]
		port, _ := strconv.Atoi(addr[idx+1:])
		// Convert * to empty for consistency
		if ip == "*" {
			ip = "0.0.0.0"
		}
		return ip, port
	}

	return addr, 0
}
