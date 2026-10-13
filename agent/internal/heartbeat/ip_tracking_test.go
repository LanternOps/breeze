package heartbeat

import "testing"

func TestDetectIPChanges_NewAndRemoved(t *testing.T) {
	previous := []IPHistoryEntry{
		{InterfaceName: "eth0", IPAddress: "10.0.0.10", IPType: "ipv4", AssignmentType: "dhcp"},
		{InterfaceName: "eth0", IPAddress: "2001:db8::10", IPType: "ipv6", AssignmentType: "static"},
	}
	current := []IPHistoryEntry{
		{InterfaceName: "eth0", IPAddress: "10.0.0.11", IPType: "ipv4", AssignmentType: "dhcp"},
		{InterfaceName: "eth0", IPAddress: "2001:db8::10", IPType: "ipv6", AssignmentType: "static"},
	}

	changed, removed := detectIPChanges(current, previous)
	if len(changed) != 1 {
		t.Fatalf("expected 1 changed ip, got %d", len(changed))
	}
	if changed[0].IPAddress != "10.0.0.11" {
		t.Fatalf("expected changed ip 10.0.0.11, got %s", changed[0].IPAddress)
	}

	if len(removed) != 1 {
		t.Fatalf("expected 1 removed ip, got %d", len(removed))
	}
	if removed[0].IPAddress != "10.0.0.10" {
		t.Fatalf("expected removed ip 10.0.0.10, got %s", removed[0].IPAddress)
	}
}

func TestDetectIPChanges_AssignmentTypeChange(t *testing.T) {
	previous := []IPHistoryEntry{
		{InterfaceName: "eth0", IPAddress: "10.0.0.10", IPType: "ipv4", AssignmentType: "static"},
	}
	current := []IPHistoryEntry{
		{InterfaceName: "eth0", IPAddress: "10.0.0.10", IPType: "ipv4", AssignmentType: "dhcp"},
	}

	changed, removed := detectIPChanges(current, previous)
	if len(changed) != 1 {
		t.Fatalf("expected assignment type change to be detected, got %d changed", len(changed))
	}
	if len(removed) != 0 {
		t.Fatalf("expected 0 removed entries, got %d", len(removed))
	}
}

func TestIsLinkLocal(t *testing.T) {
	tests := []struct {
		ip   string
		want bool
	}{
		{ip: "169.254.10.10", want: true},
		{ip: "10.0.0.10", want: false},
		{ip: "fe80::1", want: true},
		{ip: "2001:db8::1", want: false},
	}

	for _, tt := range tests {
		if got := isLinkLocal(tt.ip); got != tt.want {
			t.Fatalf("isLinkLocal(%s) = %v, want %v", tt.ip, got, tt.want)
		}
	}
}

func TestIsVPNInterface(t *testing.T) {
	tests := []struct {
		name  string
		iface string
		want  bool
	}{
		{name: "wireguard prefix", iface: "wg0", want: true},
		{name: "openvpn token", iface: "OpenVPN TAP", want: true},
		{name: "anyconnect token", iface: "Cisco AnyConnect Secure Mobility Client", want: true},
		{name: "normal ethernet", iface: "eth0", want: false},
	}

	for _, tt := range tests {
		if got := isVPNInterface(tt.iface); got != tt.want {
			t.Fatalf("%s: isVPNInterface(%q) = %v, want %v", tt.name, tt.iface, got, tt.want)
		}
	}
}

func TestDetectIPChanges_DNSServers(t *testing.T) {
	base := IPHistoryEntry{InterfaceName: "Ethernet", IPAddress: "10.0.0.10", IPType: "ipv4", AssignmentType: "static", Gateway: "10.0.0.1"}
	with := func(dns ...string) IPHistoryEntry { e := base; e.DNSServers = dns; return e }
	tests := []struct {
		name     string
		previous IPHistoryEntry
		current  IPHistoryEntry
		changed  bool
	}{
		{name: "unchanged", previous: with("10.0.0.53"), current: with("10.0.0.53"), changed: false},
		{name: "all resolvers removed", previous: with("10.0.0.53"), current: with(), changed: true},
		{name: "resolver added", previous: with(), current: with("10.0.0.53"), changed: true},
		{name: "resolver order changed", previous: with("10.0.0.53", "10.0.0.54"), current: with("10.0.0.54", "10.0.0.53"), changed: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			changed, removed := detectIPChanges([]IPHistoryEntry{tt.current}, []IPHistoryEntry{tt.previous})
			if (len(changed) == 1) != tt.changed || len(removed) != 0 {
				t.Fatalf("changed=%v removed=%v, want changed=%v", changed, removed, tt.changed)
			}
		})
	}
}
