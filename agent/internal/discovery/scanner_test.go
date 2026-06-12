package discovery

import (
	"net"
	"reflect"
	"testing"
	"time"
)

func TestNormalizeConfigDefaults(t *testing.T) {
	cfg := normalizeConfig(ScanConfig{})
	if cfg.Timeout != 2*time.Second {
		t.Fatalf("Timeout = %v, want 2s", cfg.Timeout)
	}
	if cfg.Concurrency != 128 {
		t.Fatalf("Concurrency = %d, want 128", cfg.Concurrency)
	}
	if len(cfg.Methods) == 0 {
		t.Fatal("Methods should have defaults")
	}
	if len(cfg.PortRanges) == 0 {
		t.Fatal("PortRanges should have defaults")
	}
	if len(cfg.SNMPCommunities) == 0 {
		t.Fatal("SNMPCommunities should have defaults")
	}
	if cfg.SNMPCommunities[0] != "public" {
		t.Fatalf("SNMPCommunities[0] = %q, want %q", cfg.SNMPCommunities[0], "public")
	}
}

func TestNormalizeConfigPreservesExplicitValues(t *testing.T) {
	cfg := normalizeConfig(ScanConfig{
		Timeout:         5 * time.Second,
		Concurrency:     64,
		Methods:         []string{"ping"},
		PortRanges:      []string{"80,443"},
		SNMPCommunities: []string{"private"},
	})
	if cfg.Timeout != 5*time.Second {
		t.Fatalf("Timeout = %v, want 5s", cfg.Timeout)
	}
	if cfg.Concurrency != 64 {
		t.Fatalf("Concurrency = %d, want 64", cfg.Concurrency)
	}
	if len(cfg.Methods) != 1 || cfg.Methods[0] != "ping" {
		t.Fatalf("Methods = %v, want [ping]", cfg.Methods)
	}
	if len(cfg.PortRanges) != 1 || cfg.PortRanges[0] != "80,443" {
		t.Fatalf("PortRanges = %v, want [80,443]", cfg.PortRanges)
	}
	if cfg.SNMPCommunities[0] != "private" {
		t.Fatalf("SNMPCommunities[0] = %q, want %q", cfg.SNMPCommunities[0], "private")
	}
}

func TestNormalizeConfigNegativeConcurrency(t *testing.T) {
	cfg := normalizeConfig(ScanConfig{Concurrency: -1})
	if cfg.Concurrency != 128 {
		t.Fatalf("Concurrency = %d, want 128 (negative should default)", cfg.Concurrency)
	}
}

func TestNormalizeMethods(t *testing.T) {
	tests := []struct {
		name    string
		input   []string
		wantKey string
		want    bool
	}{
		{"lowercase", []string{"ping"}, "ping", true},
		{"uppercase", []string{"PING"}, "ping", true},
		{"mixed_case", []string{"Port_Scan"}, "port_scan", true},
		{"with_spaces", []string{"  arp  "}, "arp", true},
		{"missing_key", []string{"ping"}, "arp", false},
		{"multiple", []string{"ping", "arp", "snmp"}, "snmp", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := normalizeMethods(tt.input)
			if got := result[tt.wantKey]; got != tt.want {
				t.Fatalf("normalizeMethods(%v)[%q] = %v, want %v", tt.input, tt.wantKey, got, tt.want)
			}
		})
	}
}

func TestNormalizeMethodsEmpty(t *testing.T) {
	result := normalizeMethods(nil)
	if len(result) != 0 {
		t.Fatalf("normalizeMethods(nil) should return empty map, got %d entries", len(result))
	}
}

func TestScanSNMPUsesAllTargetsWhenPingFindsAliveSubset(t *testing.T) {
	origPingSweep := pingSweep
	origDiscoverSNMP := discoverSNMP
	origReadARPCache := readARPCache
	t.Cleanup(func() {
		pingSweep = origPingSweep
		discoverSNMP = origDiscoverSNMP
		readARPCache = origReadARPCache
	})

	pingSweep = func(targets []net.IP, timeout time.Duration, workers int) []PingResult {
		return []PingResult{{IP: net.ParseIP("192.0.2.10"), RTT: 5 * time.Millisecond}}
	}
	readARPCache = func() map[string]string {
		return map[string]string{}
	}

	var snmpTargets []string
	discoverSNMP = func(targets []net.IP, communities []string, timeout time.Duration, workers int) map[string]*SNMPInfo {
		for _, target := range targets {
			snmpTargets = append(snmpTargets, target.String())
		}
		return map[string]*SNMPInfo{
			"192.0.2.11": {
				SysDescr:    "Switch OS",
				SysObjectID: "1.3.6.1.4.1.9.1.1",
				SysName:     "edge-switch",
			},
		}
	}

	scanner := NewScanner(ScanConfig{
		Subnets: []string{"192.0.2.10", "192.0.2.11"},
		Methods: []string{"ping", "snmp"},
	})

	hosts, err := scanner.Scan()
	if err != nil {
		t.Fatalf("Scan() error = %v", err)
	}

	wantTargets := []string{"192.0.2.10", "192.0.2.11"}
	if !reflect.DeepEqual(snmpTargets, wantTargets) {
		t.Fatalf("SNMP targets = %v, want %v", snmpTargets, wantTargets)
	}

	var snmpOnlyHost *DiscoveredHost
	for i := range hosts {
		if hosts[i].IP == "192.0.2.11" {
			snmpOnlyHost = &hosts[i]
			break
		}
	}
	if snmpOnlyHost == nil {
		t.Fatal("expected non-pingable SNMP responder to be included in scan results")
	}
	if snmpOnlyHost.SNMPData == nil || snmpOnlyHost.SNMPData.SysName != "edge-switch" {
		t.Fatalf("SNMP data = %+v, want sysName edge-switch", snmpOnlyHost.SNMPData)
	}
	if !reflect.DeepEqual(snmpOnlyHost.Methods, []string{"snmp"}) {
		t.Fatalf("SNMP-only host methods = %v, want [snmp]", snmpOnlyHost.Methods)
	}
}

// When SNMP is the only method, ping never runs, so aliveTargets is empty and
// portTargets falls back to the full set. SNMP must still probe every target.
func TestScanSNMPProbesAllTargetsWithoutPing(t *testing.T) {
	origDiscoverSNMP := discoverSNMP
	origReadARPCache := readARPCache
	t.Cleanup(func() {
		discoverSNMP = origDiscoverSNMP
		readARPCache = origReadARPCache
	})
	readARPCache = func() map[string]string { return map[string]string{} }

	var snmpTargets []string
	discoverSNMP = func(targets []net.IP, communities []string, timeout time.Duration, workers int) map[string]*SNMPInfo {
		for _, target := range targets {
			snmpTargets = append(snmpTargets, target.String())
		}
		return map[string]*SNMPInfo{}
	}

	scanner := NewScanner(ScanConfig{
		Subnets: []string{"192.0.2.10", "192.0.2.11"},
		Methods: []string{"snmp"},
	})
	if _, err := scanner.Scan(); err != nil {
		t.Fatalf("Scan() error = %v", err)
	}

	wantTargets := []string{"192.0.2.10", "192.0.2.11"}
	if !reflect.DeepEqual(snmpTargets, wantTargets) {
		t.Fatalf("SNMP targets = %v, want %v", snmpTargets, wantTargets)
	}
}

// The fix decouples SNMP from the port-scan target set. With ping, ports, and
// snmp all enabled, ports must stay on the ping-alive subset while SNMP probes
// every target — regressing either direction would be a real defect.
func TestScanPortsUseAliveSubsetWhileSNMPUsesAllTargets(t *testing.T) {
	origPingSweep := pingSweep
	origScanPorts := scanPorts
	origDiscoverSNMP := discoverSNMP
	origReadARPCache := readARPCache
	t.Cleanup(func() {
		pingSweep = origPingSweep
		scanPorts = origScanPorts
		discoverSNMP = origDiscoverSNMP
		readARPCache = origReadARPCache
	})
	readARPCache = func() map[string]string { return map[string]string{} }

	pingSweep = func(targets []net.IP, timeout time.Duration, workers int) []PingResult {
		return []PingResult{{IP: net.ParseIP("192.0.2.10"), RTT: 5 * time.Millisecond}}
	}

	var portTargets []string
	scanPorts = func(targets []net.IP, portRanges []PortRange, timeout time.Duration, workers int) map[string][]OpenPort {
		for _, target := range targets {
			portTargets = append(portTargets, target.String())
		}
		return map[string][]OpenPort{}
	}

	var snmpTargets []string
	discoverSNMP = func(targets []net.IP, communities []string, timeout time.Duration, workers int) map[string]*SNMPInfo {
		for _, target := range targets {
			snmpTargets = append(snmpTargets, target.String())
		}
		return map[string]*SNMPInfo{}
	}

	scanner := NewScanner(ScanConfig{
		Subnets:    []string{"192.0.2.10", "192.0.2.11"},
		Methods:    []string{"ping", "ports", "snmp"},
		PortRanges: []string{"22"},
	})
	if _, err := scanner.Scan(); err != nil {
		t.Fatalf("Scan() error = %v", err)
	}

	if want := []string{"192.0.2.10"}; !reflect.DeepEqual(portTargets, want) {
		t.Fatalf("port targets = %v, want %v (ping-alive subset)", portTargets, want)
	}
	if want := []string{"192.0.2.10", "192.0.2.11"}; !reflect.DeepEqual(snmpTargets, want) {
		t.Fatalf("SNMP targets = %v, want %v (full set)", snmpTargets, want)
	}
}

func TestParseSubnets(t *testing.T) {
	tests := []struct {
		name    string
		input   []string
		count   int
		wantErr bool
	}{
		{"single_cidr", []string{"192.168.1.0/24"}, 1, false},
		{"single_ip", []string{"10.0.0.1"}, 1, false},
		{"multiple_subnets", []string{"192.168.1.0/24", "10.0.0.0/16"}, 2, false},
		{"empty_list", []string{}, 0, false},
		{"nil_list", nil, 0, false},
		{"whitespace_entry", []string{"  "}, 0, false},
		{"mixed_valid_whitespace", []string{"192.168.1.0/24", "  ", "10.0.0.1"}, 2, false},
		{"invalid_cidr", []string{"999.999.999.0/24"}, 0, true},
		{"invalid_ip", []string{"not-an-ip"}, 0, true},
		{"invalid_mask", []string{"192.168.1.0/99"}, 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := parseSubnets(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseSubnets(%v) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
			if !tt.wantErr && len(result) != tt.count {
				t.Fatalf("parseSubnets(%v) returned %d subnets, want %d", tt.input, len(result), tt.count)
			}
		})
	}
}

func TestParseSubnetsSingleIPMask(t *testing.T) {
	result, err := parseSubnets([]string{"10.0.0.5"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 subnet, got %d", len(result))
	}
	ones, bits := result[0].Mask.Size()
	if ones != 32 || bits != 32 {
		t.Fatalf("single IP mask = /%d (of %d), want /32", ones, bits)
	}
}

func TestFingerprintOS(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
		want string
	}{
		{
			name: "snmp_windows",
			host: DiscoveredHost{
				SNMPData: &SNMPInfo{SysDescr: "Hardware: x64 Windows Server 2019"},
			},
			want: "Windows",
		},
		{
			name: "snmp_linux",
			host: DiscoveredHost{
				SNMPData: &SNMPInfo{SysDescr: "Linux server01 5.4.0 #1 SMP"},
			},
			want: "Linux",
		},
		{
			name: "snmp_darwin",
			host: DiscoveredHost{
				SNMPData: &SNMPInfo{SysDescr: "Darwin Kernel Version 21.0"},
			},
			want: "macOS",
		},
		{
			name: "snmp_cisco",
			host: DiscoveredHost{
				SNMPData: &SNMPInfo{SysDescr: "Cisco IOS Software, Version 15.1"},
			},
			want: "Cisco IOS",
		},
		{
			name: "snmp_unknown",
			host: DiscoveredHost{
				SNMPData: &SNMPInfo{SysDescr: "Some Custom Firmware"},
			},
			want: "",
		},
		{
			name: "port_rdp_windows",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{{Port: 3389, Service: "rdp"}},
			},
			want: "Windows",
		},
		{
			name: "port_smb_windows",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{{Port: 445, Service: "smb"}},
			},
			want: "Windows",
		},
		{
			name: "port_netbios_windows",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{{Port: 139, Service: "netbios-ssn"}},
			},
			want: "Windows",
		},
		{
			name: "port_ssh_unix",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{{Port: 22, Service: "ssh"}},
			},
			want: "Unix",
		},
		{
			name: "no_snmp_no_ports",
			host: DiscoveredHost{IP: "10.0.0.1"},
			want: "",
		},
		{
			name: "snmp_nil",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{{Port: 80, Service: "http"}},
			},
			want: "",
		},
		{
			name: "snmp_priority_over_ports",
			host: DiscoveredHost{
				SNMPData:  &SNMPInfo{SysDescr: "Linux server 5.4.0"},
				OpenPorts: []OpenPort{{Port: 3389, Service: "rdp"}},
			},
			want: "Linux",
		},
		{
			name: "port_iteration_order_ssh_first",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{
					{Port: 22, Service: "ssh"},
					{Port: 3389, Service: "rdp"},
				},
			},
			// fingerprintOS checks ports in slice order; SSH (22) is matched first
			want: "Unix",
		},
		{
			name: "port_rdp_first_in_slice",
			host: DiscoveredHost{
				OpenPorts: []OpenPort{
					{Port: 3389, Service: "rdp"},
					{Port: 22, Service: "ssh"},
				},
			},
			want: "Windows",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := fingerprintOS(tt.host); got != tt.want {
				t.Fatalf("fingerprintOS() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNewScanner(t *testing.T) {
	cfg := ScanConfig{
		Subnets: []string{"192.168.1.0/24"},
		Methods: []string{"ping"},
	}
	scanner := NewScanner(cfg)
	if scanner == nil {
		t.Fatal("NewScanner returned nil")
	}
	// Config should be normalized
	if scanner.config.Timeout != 2*time.Second {
		t.Fatalf("Timeout not normalized: %v", scanner.config.Timeout)
	}
	if scanner.config.Concurrency != 128 {
		t.Fatalf("Concurrency not normalized: %d", scanner.config.Concurrency)
	}
}

func TestScanNoSubnets(t *testing.T) {
	scanner := NewScanner(ScanConfig{})
	_, err := scanner.Scan()
	if err == nil {
		t.Fatal("Scan with no subnets should return error")
	}
}

func TestScanInvalidSubnet(t *testing.T) {
	scanner := NewScanner(ScanConfig{
		Subnets: []string{"not-a-subnet"},
	})
	_, err := scanner.Scan()
	if err == nil {
		t.Fatal("Scan with invalid subnet should return error")
	}
}

func TestScanAllExcluded(t *testing.T) {
	scanner := NewScanner(ScanConfig{
		Subnets:    []string{"10.0.0.1"},
		ExcludeIPs: []string{"10.0.0.1"},
		Methods:    []string{"port_scan"},
	})
	_, err := scanner.Scan()
	if err == nil {
		t.Fatal("Scan with all targets excluded should return error")
	}
}
