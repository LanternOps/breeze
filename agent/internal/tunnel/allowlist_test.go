package tunnel

import (
	"testing"
)

func TestParseAllowlistRule(t *testing.T) {
	tests := []struct {
		name    string
		pattern string
		wantErr bool
		check   func(AllowlistRule) bool
	}{
		{
			name:    "CIDR with port range",
			pattern: "192.168.0.0/16:80-443",
			check: func(r AllowlistRule) bool {
				return r.PortMin == 80 && r.PortMax == 443 && !r.AllPorts
			},
		},
		{
			name:    "single IP with single port",
			pattern: "10.0.0.5:9090",
			check: func(r AllowlistRule) bool {
				return r.PortMin == 9090 && r.PortMax == 9090
			},
		},
		{
			name:    "CIDR with wildcard port",
			pattern: "10.0.0.0/8:*",
			check: func(r AllowlistRule) bool {
				return r.AllPorts
			},
		},
		{
			name:    "missing port part",
			pattern: "192.168.0.0/16",
			wantErr: true,
		},
		{
			name:    "invalid CIDR",
			pattern: "999.999.999.999/32:80",
			wantErr: true,
		},
		{
			name:    "invalid port range reversed",
			pattern: "10.0.0.0/8:443-80",
			wantErr: true,
		},
		{
			name:    "port out of range",
			pattern: "10.0.0.0/8:99999",
			wantErr: true,
		},
		{
			name:    "port zero",
			pattern: "10.0.0.0/8:0",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rule, err := ParseAllowlistRule(tt.pattern)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for pattern %q, got nil", tt.pattern)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tt.check != nil && !tt.check(rule) {
				t.Fatalf("check failed for pattern %q", tt.pattern)
			}
		})
	}
}

func TestIsBlocked(t *testing.T) {
	tests := []struct {
		name    string
		host    string
		port    int
		isVNC   bool
		blocked bool
	}{
		{"localhost blocked", "127.0.0.1", 8080, false, true},
		{"localhost:22 blocked", "127.0.0.1", 22, false, true},
		{"VNC on localhost allowed", "127.0.0.1", 5900, true, false},
		{"VNC on 127.0.0.2 blocked", "127.0.0.2", 5900, true, true},
		{"link-local blocked", "169.254.169.254", 80, false, true},
		{"link-local all blocked", "169.254.1.1", 443, false, true},
		{"0.0.0.0 blocked", "0.0.0.0", 80, false, true},
		{"IPv6 zero blocked", "::", 80, false, true},
		{"private RFC1918 allowed", "192.168.1.1", 80, false, false},
		{"private 10.x allowed", "10.0.0.1", 443, false, false},
		{"public IP allowed", "8.8.8.8", 53, false, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			blocked, reason := IsBlocked(tt.host, tt.port, tt.isVNC)
			if blocked != tt.blocked {
				t.Fatalf("IsBlocked(%q, %d, %v) = %v (%s), want %v",
					tt.host, tt.port, tt.isVNC, blocked, reason, tt.blocked)
			}
		})
	}
}

func TestIsAllowed(t *testing.T) {
	rules := []AllowlistRule{
		mustParseRule(t, "192.168.0.0/16:80-443"),
		mustParseRule(t, "10.0.0.0/8:*"),
	}

	tests := []struct {
		name    string
		host    string
		port    int
		allowed bool
	}{
		{"192.168 port 80 allowed", "192.168.1.1", 80, true},
		{"192.168 port 443 allowed", "192.168.1.1", 443, true},
		{"192.168 port 8080 denied", "192.168.1.1", 8080, false},
		{"10.x any port allowed", "10.0.5.10", 9090, true},
		{"172.16 not in rules", "172.16.0.1", 80, false},
		{"public IP not in rules", "8.8.8.8", 53, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			allowed := IsAllowed(tt.host, tt.port, rules)
			if allowed != tt.allowed {
				t.Fatalf("IsAllowed(%q, %d) = %v, want %v",
					tt.host, tt.port, allowed, tt.allowed)
			}
		})
	}
}

func TestIsAllowed_EmptyRules(t *testing.T) {
	if IsAllowed("192.168.1.1", 80, nil) {
		t.Fatal("empty rules should deny all")
	}
	if IsAllowed("192.168.1.1", 80, []AllowlistRule{}) {
		t.Fatal("empty rules should deny all")
	}
}

func mustParseRule(t *testing.T, pattern string) AllowlistRule {
	t.Helper()
	rule, err := ParseAllowlistRule(pattern)
	if err != nil {
		t.Fatalf("failed to parse rule %q: %v", pattern, err)
	}
	return rule
}
