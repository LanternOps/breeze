//go:build linux

package collectors

import (
	"testing"

	gopsnet "github.com/shirou/gopsutil/v3/net"
)

func TestGetProtocolString(t *testing.T) {
	c := &ConnectionsCollector{}
	tests := []struct {
		connType uint32
		family   uint32
		want     string
	}{
		{connType: 1, family: 2, want: "tcp"},
		{connType: 1, family: 10, want: "tcp6"},
		{connType: 2, family: 2, want: "udp"},
		{connType: 2, family: 10, want: "udp6"},
		{connType: 3, family: 1, want: "unknown"},
		{connType: 5, family: 1, want: "unknown"},
	}

	for _, tt := range tests {
		got := c.getProtocolString(tt.connType, tt.family)
		if got != tt.want {
			t.Errorf("getProtocolString(%d, %d) = %q, want %q", tt.connType, tt.family, got, tt.want)
		}
	}
}

func TestMapConnectionFiltersUnknownProtocol(t *testing.T) {
	c := &ConnectionsCollector{}
	conn := gopsnet.ConnectionStat{
		Type:   3, // SOCK_RAW — not TCP or UDP
		Family: 1, // AF_UNIX
		Laddr:  gopsnet.Addr{IP: "0.0.0.0", Port: 0},
	}
	result := c.mapConnection(conn, "")
	if result != nil {
		t.Errorf("expected nil for unknown protocol, got %+v", result)
	}
}

func TestMapConnectionReturnsTCPConnection(t *testing.T) {
	c := &ConnectionsCollector{}
	conn := gopsnet.ConnectionStat{
		Type:   1, // SOCK_STREAM = TCP
		Family: 2, // AF_INET = IPv4
		Laddr:  gopsnet.Addr{IP: "127.0.0.1", Port: 8080},
		Raddr:  gopsnet.Addr{IP: "10.0.0.1", Port: 54321},
		Status: "ESTABLISHED",
		Pid:    1234,
	}
	result := c.mapConnection(conn, "nginx")
	if result == nil {
		t.Fatal("expected non-nil result for TCP connection")
	}
	if result.Protocol != "tcp" {
		t.Errorf("Protocol = %q, want %q", result.Protocol, "tcp")
	}
	if result.LocalAddr != "127.0.0.1" || result.LocalPort != 8080 {
		t.Errorf("LocalAddr = %q:%d, want 127.0.0.1:8080", result.LocalAddr, result.LocalPort)
	}
	if result.ProcessName != "nginx" {
		t.Errorf("ProcessName = %q, want %q", result.ProcessName, "nginx")
	}
}
