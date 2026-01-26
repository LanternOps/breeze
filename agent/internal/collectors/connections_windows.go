//go:build windows

package collectors

import (
	"github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// Collect gathers all active network connections on Windows
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

		protocol := c.getProtocolString(conn.Type, conn.Family)

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

func (c *ConnectionsCollector) getProtocolString(connType uint32, family uint32) string {
	// Windows uses AF_INET=2, AF_INET6=23
	isIPv6 := family == 23

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
