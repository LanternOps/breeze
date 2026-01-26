package collectors

// ConnectionInfo represents an active network connection
type ConnectionInfo struct {
	Protocol    string `json:"protocol"`    // tcp, tcp6, udp, udp6
	LocalAddr   string `json:"localAddr"`   // Local IP address
	LocalPort   int    `json:"localPort"`   // Local port
	RemoteAddr  string `json:"remoteAddr"`  // Remote IP address (empty for listening)
	RemotePort  int    `json:"remotePort"`  // Remote port (0 for listening)
	State       string `json:"state"`       // Connection state (LISTEN, ESTABLISHED, etc.)
	Pid         int    `json:"pid"`         // Process ID (0 if unavailable)
	ProcessName string `json:"processName"` // Process name (empty if unavailable)
}

// ConnectionsCollector collects active network connections
type ConnectionsCollector struct{}

// NewConnectionsCollector creates a new connections collector
func NewConnectionsCollector() *ConnectionsCollector {
	return &ConnectionsCollector{}
}
