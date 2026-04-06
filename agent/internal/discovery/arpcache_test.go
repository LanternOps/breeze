package discovery

import (
	"testing"
)

func TestParseARPLineMacOS(t *testing.T) {
	tests := []struct {
		name    string
		line    string
		wantIP  string
		wantMAC string
	}{
		{
			name:    "standard",
			line:    "? (192.168.0.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]",
			wantIP:  "192.168.0.1",
			wantMAC: "aa:bb:cc:dd:ee:ff",
		},
		{
			// net.ParseMAC rejects single-char octets like "a:b:c:d:e:f",
			// so parseARPLine correctly returns empty for this format.
			name:    "short_octets_rejected",
			line:    "? (10.0.0.1) at a:b:c:d:e:f on en0 ifscope [ethernet]",
			wantIP:  "",
			wantMAC: "",
		},
		{
			name:    "zero_padded_short_octets",
			line:    "? (10.0.0.1) at 0a:0b:0c:0d:0e:0f on en0 ifscope [ethernet]",
			wantIP:  "10.0.0.1",
			wantMAC: "0a:0b:0c:0d:0e:0f",
		},
		{
			name:    "mixed_case",
			line:    "? (172.16.0.1) at AA:BB:CC:DD:EE:FF on en0",
			wantIP:  "172.16.0.1",
			wantMAC: "aa:bb:cc:dd:ee:ff",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip, mac := parseARPLine(tt.line)
			if ip != tt.wantIP {
				t.Fatalf("IP = %q, want %q", ip, tt.wantIP)
			}
			if mac != tt.wantMAC {
				t.Fatalf("MAC = %q, want %q", mac, tt.wantMAC)
			}
		})
	}
}

func TestParseARPLineLinux(t *testing.T) {
	line := "? (192.168.1.100) at 01:23:45:67:89:ab [ether] on eth0"
	ip, mac := parseARPLine(line)
	if ip != "192.168.1.100" {
		t.Fatalf("IP = %q, want %q", ip, "192.168.1.100")
	}
	if mac != "01:23:45:67:89:ab" {
		t.Fatalf("MAC = %q, want %q", mac, "01:23:45:67:89:ab")
	}
}

func TestParseARPLineWindows(t *testing.T) {
	tests := []struct {
		name    string
		line    string
		wantIP  string
		wantMAC string
	}{
		{
			name:    "standard",
			line:    "  192.168.0.1          aa-bb-cc-dd-ee-ff     dynamic",
			wantIP:  "192.168.0.1",
			wantMAC: "aa:bb:cc:dd:ee:ff",
		},
		{
			name:    "static",
			line:    "  10.0.0.254           01-23-45-67-89-ab     static",
			wantIP:  "10.0.0.254",
			wantMAC: "01:23:45:67:89:ab",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip, mac := parseARPLine(tt.line)
			if ip != tt.wantIP {
				t.Fatalf("IP = %q, want %q", ip, tt.wantIP)
			}
			if mac != tt.wantMAC {
				t.Fatalf("MAC = %q, want %q", mac, tt.wantMAC)
			}
		})
	}
}

func TestParseARPLineIncomplete(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{"incomplete_lowercase", "? (192.168.0.5) at (incomplete) on en0"},
		{"incomplete_uppercase", "? (192.168.0.5) at INCOMPLETE on en0"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip, mac := parseARPLine(tt.line)
			if ip != "" || mac != "" {
				t.Fatalf("incomplete entry should return empty, got IP=%q MAC=%q", ip, mac)
			}
		})
	}
}

func TestParseARPLineEmptyAndWhitespace(t *testing.T) {
	tests := []struct {
		name string
		line string
	}{
		{"empty", ""},
		{"whitespace_only", "   "},
		{"tab_only", "\t"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip, mac := parseARPLine(tt.line)
			if ip != "" || mac != "" {
				t.Fatalf("empty/whitespace line should return empty, got IP=%q MAC=%q", ip, mac)
			}
		})
	}
}

func TestParseARPLineNoMAC(t *testing.T) {
	line := "? (192.168.0.1) at -- on en0"
	ip, mac := parseARPLine(line)
	if ip != "" || mac != "" {
		t.Fatalf("line without MAC should return empty, got IP=%q MAC=%q", ip, mac)
	}
}

func TestParseARPLineNoIP(t *testing.T) {
	// A line with a MAC but no valid IP
	line := "garbage text with aa:bb:cc:dd:ee:ff"
	ip, mac := parseARPLine(line)
	if ip != "" || mac != "" {
		t.Fatalf("line without valid IP should return empty, got IP=%q MAC=%q", ip, mac)
	}
}

func TestParseARPLineInvalidIP(t *testing.T) {
	line := "? (not-an-ip) at aa:bb:cc:dd:ee:ff on en0"
	ip, mac := parseARPLine(line)
	if ip != "" || mac != "" {
		t.Fatalf("invalid IP in parens should return empty, got IP=%q MAC=%q", ip, mac)
	}
}

func TestParseARPLineHeaderLine(t *testing.T) {
	// Windows ARP output includes header lines
	lines := []string{
		"Interface: 192.168.1.100 --- 0xa",
		"  Internet Address      Physical Address      Type",
	}
	for _, line := range lines {
		ip, mac := parseARPLine(line)
		if ip != "" && mac != "" {
			t.Fatalf("header line %q should not parse, got IP=%q MAC=%q", line, ip, mac)
		}
	}
}

func TestNormalizeMAC(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"colon_separated", "aa:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff"},
		{"dash_separated", "aa-bb-cc-dd-ee-ff", "aa:bb:cc:dd:ee:ff"},
		{"uppercase", "AA:BB:CC:DD:EE:FF", "aa:bb:cc:dd:ee:ff"},
		// net.ParseMAC rejects single-char octets
		{"short_octets_rejected", "a:b:c:d:e:f", ""},
		{"zero_padded_short", "0a:0b:0c:0d:0e:0f", "0a:0b:0c:0d:0e:0f"},
		{"mixed_case_dash", "Aa-Bb-Cc-Dd-Ee-Ff", "aa:bb:cc:dd:ee:ff"},
		{"invalid", "not-a-mac", ""},
		{"empty", "", ""},
		{"too_short", "aa:bb:cc", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeMAC(tt.input); got != tt.want {
				t.Fatalf("normalizeMAC(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestMacPatternRegex(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"colon_format", "aa:bb:cc:dd:ee:ff", true},
		{"dash_format", "aa-bb-cc-dd-ee-ff", true},
		{"mixed_separators", "aa:bb-cc:dd-ee:ff", true},
		{"short_octets", "a:b:c:d:e:f", true},
		{"uppercase", "AA:BB:CC:DD:EE:FF", true},
		{"no_match", "hello world", false},
		{"partial", "aa:bb:cc", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := macPattern.MatchString(tt.input)
			if got != tt.want {
				t.Fatalf("macPattern.MatchString(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseARPLineMultipleFormats(t *testing.T) {
	// Comprehensive table-driven test across all OS formats
	tests := []struct {
		name    string
		line    string
		wantIP  string
		wantMAC string
	}{
		{
			name:    "macos_typical",
			line:    "router.local (192.168.1.1) at 00:1a:2b:3c:4d:5e on en0 ifscope [ethernet]",
			wantIP:  "192.168.1.1",
			wantMAC: "00:1a:2b:3c:4d:5e",
		},
		{
			name:    "linux_typical",
			line:    "? (10.0.0.1) at 00:11:22:33:44:55 [ether] on eth0",
			wantIP:  "10.0.0.1",
			wantMAC: "00:11:22:33:44:55",
		},
		{
			name:    "windows_typical",
			line:    "  172.16.0.1          00-11-22-33-44-55     dynamic",
			wantIP:  "172.16.0.1",
			wantMAC: "00:11:22:33:44:55",
		},
		{
			name:    "broadcast_mac",
			line:    "? (192.168.0.255) at ff:ff:ff:ff:ff:ff on en0",
			wantIP:  "192.168.0.255",
			wantMAC: "ff:ff:ff:ff:ff:ff",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ip, mac := parseARPLine(tt.line)
			if ip != tt.wantIP {
				t.Fatalf("IP = %q, want %q", ip, tt.wantIP)
			}
			if mac != tt.wantMAC {
				t.Fatalf("MAC = %q, want %q", mac, tt.wantMAC)
			}
		})
	}
}
