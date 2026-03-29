package discovery

import (
	"net"
	"testing"
)

func TestIdentifyService(t *testing.T) {
	tests := []struct {
		port int
		want string
	}{
		{22, "ssh"},
		{23, "telnet"},
		{25, "smtp"},
		{53, "dns"},
		{80, "http"},
		{110, "pop3"},
		{135, "rpc"},
		{139, "netbios-ssn"},
		{143, "imap"},
		{161, "snmp"},
		{443, "https"},
		{445, "smb"},
		{465, "smtps"},
		{587, "smtp"},
		{631, "ipp"},
		{993, "imaps"},
		{995, "pop3s"},
		{1433, "mssql"},
		{1521, "oracle"},
		{2049, "nfs"},
		{3306, "mysql"},
		{3389, "rdp"},
		{5432, "postgres"},
		{5672, "amqp"},
		{5985, "winrm"},
		{5986, "winrm"},
		{6379, "redis"},
		{8080, "http-alt"},
		{8443, "https-alt"},
		{9100, "printer"},
		{12345, ""},
		{0, ""},
		{1, ""},
		{65535, ""},
	}

	for _, tt := range tests {
		got := identifyService(tt.port)
		if got != tt.want {
			t.Fatalf("identifyService(%d) = %q, want %q", tt.port, got, tt.want)
		}
	}
}

func TestScanPortsEmptyTargets(t *testing.T) {
	results := ScanPorts(nil, []PortRange{{Start: 80, End: 80}}, 0, 0)
	if len(results) != 0 {
		t.Fatalf("ScanPorts with nil targets should return empty, got %d entries", len(results))
	}
}

func TestScanPortsEmptyPortRanges(t *testing.T) {
	targets := []net.IP{net.ParseIP("127.0.0.1")}
	results := ScanPorts(targets, nil, 0, 0)
	if len(results) != 0 {
		t.Fatalf("ScanPorts with nil portRanges should return empty, got %d entries", len(results))
	}
}

func TestScanPortsEmptyBoth(t *testing.T) {
	results := ScanPorts(nil, nil, 0, 0)
	if len(results) != 0 {
		t.Fatalf("ScanPorts with nil targets and ranges should return empty, got %d entries", len(results))
	}
}

func TestScanPortsDefaultTimeout(t *testing.T) {
	// ScanPorts should handle zero timeout gracefully (default to 2s)
	// Using a non-routable IP to avoid actual connections
	targets := []net.IP{net.ParseIP("192.0.2.1")}
	portRanges := []PortRange{{Start: 99, End: 99}}
	// This should not panic; the non-routable IP will simply fail to connect
	results := ScanPorts(targets, portRanges, 0, 1)
	// We don't expect any open ports on a non-routable address
	if len(results) != 0 {
		t.Fatalf("expected no results for non-routable IP, got %d", len(results))
	}
}

func TestScanPortsDefaultWorkers(t *testing.T) {
	targets := []net.IP{net.ParseIP("192.0.2.1")}
	portRanges := []PortRange{{Start: 99, End: 99}}
	// workers <= 0 should default to 128 without panic
	results := ScanPorts(targets, portRanges, 0, -5)
	if len(results) != 0 {
		t.Fatalf("expected no results for non-routable IP, got %d", len(results))
	}
}

func TestPortRangeStruct(t *testing.T) {
	pr := PortRange{Start: 80, End: 443}
	if pr.Start != 80 {
		t.Fatalf("Start = %d, want 80", pr.Start)
	}
	if pr.End != 443 {
		t.Fatalf("End = %d, want 443", pr.End)
	}
}

func TestPortJobStruct(t *testing.T) {
	ip := net.ParseIP("10.0.0.1")
	job := portJob{IP: ip, Port: 443}
	if job.Port != 443 {
		t.Fatalf("Port = %d, want 443", job.Port)
	}
	if !job.IP.Equal(ip) {
		t.Fatal("IP mismatch")
	}
}
