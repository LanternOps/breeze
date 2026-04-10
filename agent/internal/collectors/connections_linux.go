//go:build linux

package collectors

import (
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// Collect gathers all active network connections on Linux
func (c *ConnectionsCollector) Collect() ([]ConnectionInfo, error) {
	conns, err := net.Connections("all")
	if err != nil {
		return nil, err
	}

	var connections []ConnectionInfo
	processCache := make(map[int32]string)

	for _, conn := range conns {
		if conn.Laddr.IP == "" {
			continue
		}

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

		if info := c.mapConnection(conn, processName); info != nil {
			connections = append(connections, *info)
		}
	}

	return connections, nil
}

// mapConnection converts a gopsutil ConnectionStat to a ConnectionInfo.
// Returns nil if the protocol is not one of the four supported types (tcp, tcp6, udp, udp6).
func (c *ConnectionsCollector) mapConnection(conn net.ConnectionStat, processName string) *ConnectionInfo {
	protocol := c.getProtocolString(conn.Type, conn.Family)
	if protocol == "unknown" {
		return nil
	}
	return &ConnectionInfo{
		Protocol:    protocol,
		LocalAddr:   conn.Laddr.IP,
		LocalPort:   int(conn.Laddr.Port),
		RemoteAddr:  conn.Raddr.IP,
		RemotePort:  int(conn.Raddr.Port),
		State:       conn.Status,
		Pid:         int(conn.Pid),
		ProcessName: processName,
	}
}

func (c *ConnectionsCollector) getProtocolString(connType uint32, family uint32) string {
	isIPv6 := family == 10

	switch connType {
	case 1:
		if isIPv6 {
			return "tcp6"
		}
		return "tcp"
	case 2:
		if isIPv6 {
			return "udp6"
		}
		return "udp"
	default:
		return "unknown"
	}
}
