package tunnel

import "testing"

func TestParseAllowlistRuleAcceptsIPv6(t *testing.T) {
	tests := []struct {
		pattern string
		network string
		min     int
		max     int
		all     bool
	}{
		{"2001:db8::/32:80-443", "2001:db8::/32", 80, 443, false},
		{"2001:db8::1:443", "2001:db8::1/128", 443, 443, false},
		{"2001:db8::/64:*", "2001:db8::/64", 0, 0, true},
		{"fd00::/8:22", "fd00::/8", 22, 22, false},
		{"192.168.0.0/16:80-443", "192.168.0.0/16", 80, 443, false},
		{"10.0.0.5:9090", "10.0.0.5/32", 9090, 9090, false},
	}
	for _, tt := range tests {
		rule, err := ParseAllowlistRule(tt.pattern)
		if err != nil {
			t.Fatalf("ParseAllowlistRule(%q) error: %v", tt.pattern, err)
		}
		if rule.Network.String() != tt.network || rule.PortMin != tt.min || rule.PortMax != tt.max || rule.AllPorts != tt.all {
			t.Fatalf("ParseAllowlistRule(%q) = %s %d-%d all=%v", tt.pattern, rule.Network, rule.PortMin, rule.PortMax, rule.AllPorts)
		}
	}
}

func TestParseAllowlistRuleRejectsMalformedPatterns(t *testing.T) {
	for _, pattern := range []string{
		":80",
		"2001:db8::/32:",
		"2001:db8::/129:80",
		"2001:db8::1/32:443", // IPv6 prefix with host bits set
		"::ffff:10.0.0.5/104:443",
		"10.0.0.5/0008:80",
		"10.0.0.5:000080",
		"10.0.0.5:80-000090",
		"192.0.2.1:+80",
		"192.0.2.1: 80",
		"host.example:443",
		"fe80::1%eth0:22",
	} {
		if _, err := ParseAllowlistRule(pattern); err == nil {
			t.Fatalf("ParseAllowlistRule(%q) accepted a malformed pattern", pattern)
		}
	}
}
