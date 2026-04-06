package discovery

import (
	"net"
	"testing"
	"time"
)

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
