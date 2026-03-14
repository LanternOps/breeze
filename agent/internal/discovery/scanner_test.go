package discovery

import (
	"net"
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

func TestExpandTargets(t *testing.T) {
	_, cidr, _ := net.ParseCIDR("192.168.1.0/30")
	exclude := map[string]struct{}{}

	targets := expandTargets([]*net.IPNet{cidr}, exclude, false)
	// /30 = 4 addresses: .0, .1, .2, .3
	if len(targets) != 4 {
		t.Fatalf("expandTargets /30 = %d targets, want 4", len(targets))
	}
}

func TestExpandTargetsWithExclusions(t *testing.T) {
	_, cidr, _ := net.ParseCIDR("192.168.1.0/30")
	exclude := map[string]struct{}{
		"192.168.1.1": {},
	}

	targets := expandTargets([]*net.IPNet{cidr}, exclude, false)
	if len(targets) != 3 {
		t.Fatalf("expandTargets /30 with 1 exclusion = %d targets, want 3", len(targets))
	}
	for _, ip := range targets {
		if ip.String() == "192.168.1.1" {
			t.Fatal("excluded IP 192.168.1.1 should not be in targets")
		}
	}
}

func TestExpandTargetsLargeSubnetWithoutDeepScan(t *testing.T) {
	_, cidr, _ := net.ParseCIDR("10.0.0.0/15")
	exclude := map[string]struct{}{}

	targets := expandTargets([]*net.IPNet{cidr}, exclude, false)
	// /15 = 131072 hosts > 65536 limit, should be skipped
	if len(targets) != 0 {
		t.Fatalf("expandTargets /15 without deepScan = %d targets, want 0", len(targets))
	}
}

func TestExpandTargetsLargeSubnetWithDeepScan(t *testing.T) {
	_, cidr, _ := net.ParseCIDR("10.0.0.0/16")
	exclude := map[string]struct{}{}

	targets := expandTargets([]*net.IPNet{cidr}, exclude, true)
	// /16 = 65536 hosts, equals limit so should be included with deepScan
	if len(targets) == 0 {
		t.Fatal("expandTargets /16 with deepScan should return targets")
	}
}

func TestExpandTargetsNilSubnet(t *testing.T) {
	targets := expandTargets([]*net.IPNet{nil}, map[string]struct{}{}, false)
	if len(targets) != 0 {
		t.Fatalf("expandTargets with nil subnet = %d targets, want 0", len(targets))
	}
}

func TestExpandTargetsEmptySubnets(t *testing.T) {
	targets := expandTargets(nil, map[string]struct{}{}, false)
	if len(targets) != 0 {
		t.Fatalf("expandTargets(nil) = %d targets, want 0", len(targets))
	}
}

func TestIncIP(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want string
	}{
		{"simple", "192.168.1.1", "192.168.1.2"},
		{"octet_rollover", "192.168.1.255", "192.168.2.0"},
		{"double_rollover", "192.168.255.255", "192.169.0.0"},
		{"triple_rollover", "192.255.255.255", "193.0.0.0"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip := net.ParseIP(tt.ip).To4()
			incIP(ip)
			if got := ip.String(); got != tt.want {
				t.Fatalf("incIP(%q) = %q, want %q", tt.ip, got, tt.want)
			}
		})
	}
}

func TestParsePortRanges(t *testing.T) {
	tests := []struct {
		name    string
		input   []string
		count   int
		wantErr bool
	}{
		{"single_port", []string{"80"}, 1, false},
		{"multiple_ports_comma_separated", []string{"22,80,443"}, 3, false},
		{"port_range", []string{"80-85"}, 1, false},
		{"mixed", []string{"22,80-85,443"}, 3, false},
		{"reversed_range", []string{"85-80"}, 1, false},
		{"whitespace", []string{"  22 , 80 "}, 2, false},
		{"empty_entries", []string{""}, 0, true},
		{"invalid_port", []string{"abc"}, 0, true},
		{"port_zero", []string{"0"}, 0, true},
		{"port_too_high", []string{"99999"}, 0, true},
		{"negative_port", []string{"-1"}, 0, true},
		{"multiple_ranges_separate_entries", []string{"22,80", "443,3389"}, 4, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result, err := parsePortRanges(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parsePortRanges(%v) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
			if !tt.wantErr && len(result) != tt.count {
				t.Fatalf("parsePortRanges(%v) returned %d ranges, want %d", tt.input, len(result), tt.count)
			}
		})
	}
}

func TestParsePortRangesReversedOrder(t *testing.T) {
	result, err := parsePortRanges([]string{"443-80"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(result) != 1 {
		t.Fatalf("expected 1 range, got %d", len(result))
	}
	if result[0].Start != 80 || result[0].End != 443 {
		t.Fatalf("reversed range = %d-%d, want 80-443", result[0].Start, result[0].End)
	}
}

func TestParsePort(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    int
		wantErr bool
	}{
		{"valid_port", "80", 80, false},
		{"max_port", "65535", 65535, false},
		{"min_port", "1", 1, false},
		{"with_spaces", "  443  ", 443, false},
		{"zero", "0", 0, true},
		{"negative", "-1", 0, true},
		{"too_high", "65536", 0, true},
		{"empty", "", 0, true},
		{"not_a_number", "abc", 0, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parsePort(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parsePort(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("parsePort(%q) = %d, want %d", tt.input, got, tt.want)
			}
		})
	}
}

func TestGetOrCreateHost(t *testing.T) {
	hosts := make(map[string]*DiscoveredHost)
	now := time.Now()

	host1 := getOrCreateHost(hosts, "10.0.0.1", now)
	if host1 == nil {
		t.Fatal("getOrCreateHost returned nil")
	}
	if host1.IP != "10.0.0.1" {
		t.Fatalf("IP = %q, want %q", host1.IP, "10.0.0.1")
	}
	if !host1.FirstSeen.Equal(now) {
		t.Fatal("FirstSeen should match provided time")
	}

	// Same IP should return existing host
	host2 := getOrCreateHost(hosts, "10.0.0.1", now.Add(time.Minute))
	if host1 != host2 {
		t.Fatal("same IP should return same host pointer")
	}

	// Different IP should return new host
	host3 := getOrCreateHost(hosts, "10.0.0.2", now)
	if host1 == host3 {
		t.Fatal("different IP should return different host pointer")
	}

	if len(hosts) != 2 {
		t.Fatalf("hosts map should have 2 entries, got %d", len(hosts))
	}
}

func TestAddMethod(t *testing.T) {
	tests := []struct {
		name     string
		methods  []string
		add      string
		wantLen  int
		wantLast string
	}{
		{"add_to_empty", nil, "ping", 1, "ping"},
		{"add_new", []string{"ping"}, "arp", 2, "arp"},
		{"add_duplicate", []string{"ping", "arp"}, "ping", 2, ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := addMethod(tt.methods, tt.add)
			if len(result) != tt.wantLen {
				t.Fatalf("addMethod len = %d, want %d", len(result), tt.wantLen)
			}
			if tt.wantLast != "" && result[len(result)-1] != tt.wantLast {
				t.Fatalf("last method = %q, want %q", result[len(result)-1], tt.wantLast)
			}
		})
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

func TestCompareIPs(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want bool
	}{
		{"less_than", "10.0.0.1", "10.0.0.2", true},
		{"equal", "10.0.0.1", "10.0.0.1", false},
		{"greater_than", "10.0.0.2", "10.0.0.1", false},
		{"different_octets", "10.0.0.1", "10.0.1.1", true},
		// When either IP is invalid, falls back to string comparison (a < b)
		{"first_invalid", "invalid", "10.0.0.1", false},  // 'i' > '1'
		{"second_invalid", "10.0.0.1", "invalid", true},  // '1' < 'i'
		{"both_invalid_alpha", "bar", "foo", true},        // 'b' < 'f'
		{"both_invalid_equal", "foo", "foo", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := compareIPs(tt.a, tt.b); got != tt.want {
				t.Fatalf("compareIPs(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
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
