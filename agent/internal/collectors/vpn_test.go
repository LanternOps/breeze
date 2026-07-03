package collectors

import (
	"testing"

	psnet "github.com/shirou/gopsutil/v3/net"
)

func TestClassifyVPNInterface(t *testing.T) {
	tests := []struct {
		name         string
		iface        string
		wantProvider string
		wantTunnel   bool
	}{
		{"tailscale linux", "tailscale0", vpnTailscale, true},
		{"tailscale windows adapter", "Tailscale", vpnTailscale, true},
		{"netbird", "netbird0", vpnNetBird, true},
		{"zerotier prefix", "ztabcd1234", vpnZeroTier, true},
		{"zerotier name", "ZeroTier One [abcd]", vpnZeroTier, true},
		{"wireguard prefix", "wg0", vpnWireGuard, true},
		{"wireguard name", "WireGuard Tunnel", vpnWireGuard, true},
		{"warp", "CloudflareWARP", vpnCloudflareWARP, true},
		{"openvpn name", "OpenVPN TAP-Windows Adapter V9", vpnOpenVPN, true},
		{"tap-windows", "TAP-Windows Adapter V9", vpnOpenVPN, true},
		{"generic utun", "utun3", vpnGeneric, true},
		{"generic tun", "tun0", vpnGeneric, true},
		{"generic tap", "tap0", vpnGeneric, true},
		{"generic ppp", "ppp0", vpnGeneric, true},
		{"generic wt (netbird linux)", "wt0", vpnGeneric, true},
		{"ethernet not tunnel", "eth0", "", false},
		{"wifi not tunnel", "wlan0", "", false},
		{"loopback not tunnel", "lo", "", false},
		{"windows ethernet", "Ethernet", "", false},
		{"empty", "", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider, isTunnel := classifyVPNInterface(tt.iface)
			if isTunnel != tt.wantTunnel {
				t.Fatalf("classifyVPNInterface(%q) tunnel = %v, want %v", tt.iface, isTunnel, tt.wantTunnel)
			}
			if provider != tt.wantProvider {
				t.Errorf("classifyVPNInterface(%q) provider = %q, want %q", tt.iface, provider, tt.wantProvider)
			}
		})
	}
}

func TestInterfaceIsUp(t *testing.T) {
	tests := []struct {
		name  string
		flags []string
		want  bool
	}{
		{"up lowercase", []string{"up", "broadcast"}, true},
		{"up mixed case", []string{"UP", "RUNNING"}, true},
		{"down", []string{"broadcast", "multicast"}, false},
		{"empty", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := interfaceIsUp(tt.flags); got != tt.want {
				t.Errorf("interfaceIsUp(%v) = %v, want %v", tt.flags, got, tt.want)
			}
		})
	}
}

func TestExtractVPNIPs(t *testing.T) {
	tests := []struct {
		name     string
		addrs    []psnet.InterfaceAddr
		wantIPv4 string
		wantIPv6 string
	}{
		{
			name:     "cidr ipv4",
			addrs:    []psnet.InterfaceAddr{{Addr: "100.101.102.103/32"}},
			wantIPv4: "100.101.102.103",
		},
		{
			name:     "bare ipv4",
			addrs:    []psnet.InterfaceAddr{{Addr: "10.8.0.2"}},
			wantIPv4: "10.8.0.2",
		},
		{
			name:     "ipv4 and global ipv6",
			addrs:    []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}, {Addr: "fd7a:115c:a1e0::1/128"}},
			wantIPv4: "100.64.0.1",
			wantIPv6: "fd7a:115c:a1e0::1",
		},
		{
			name:     "link-local ipv6 skipped",
			addrs:    []psnet.InterfaceAddr{{Addr: "fe80::1/64"}},
			wantIPv4: "",
			wantIPv6: "",
		},
		{
			name:     "first ipv4 wins",
			addrs:    []psnet.InterfaceAddr{{Addr: "10.0.0.1/24"}, {Addr: "10.0.0.2/24"}},
			wantIPv4: "10.0.0.1",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ipv4, ipv6 := extractVPNIPs(tt.addrs)
			if ipv4 != tt.wantIPv4 {
				t.Errorf("ipv4 = %q, want %q", ipv4, tt.wantIPv4)
			}
			if ipv6 != tt.wantIPv6 {
				t.Errorf("ipv6 = %q, want %q", ipv6, tt.wantIPv6)
			}
		})
	}
}

func TestSoleVPNSignal(t *testing.T) {
	tests := []struct {
		name         string
		signals      map[string]string
		wantProvider string
		wantSource   string
		wantOK       bool
	}{
		{
			name:         "single specific",
			signals:      map[string]string{vpnTailscale: vpnSourceProcess},
			wantProvider: vpnTailscale,
			wantSource:   vpnSourceProcess,
			wantOK:       true,
		},
		{
			name:    "two specific -> ambiguous",
			signals: map[string]string{vpnTailscale: vpnSourceProcess, vpnWireGuard: vpnSourceService},
			wantOK:  false,
		},
		{
			name:    "empty",
			signals: map[string]string{},
			wantOK:  false,
		},
		{
			name:         "generic ignored, one specific",
			signals:      map[string]string{vpnGeneric: vpnSourceProcess, vpnOpenVPN: vpnSourceService},
			wantProvider: vpnOpenVPN,
			wantSource:   vpnSourceService,
			wantOK:       true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider, source, ok := soleVPNSignal(tt.signals)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if ok && (provider != tt.wantProvider || source != tt.wantSource) {
				t.Errorf("got (%q,%q), want (%q,%q)", provider, source, tt.wantProvider, tt.wantSource)
			}
		})
	}
}

func TestMatchVPNServiceTokens(t *testing.T) {
	tests := []struct {
		name string
		text string
		want []string
	}{
		{
			name: "windows service names",
			text: "WireGuardTunnel$home\nTailscale\nZeroTierOneService\nOpenVPNServiceInteractive\nCloudflareWARP",
			want: []string{vpnWireGuard, vpnTailscale, vpnZeroTier, vpnOpenVPN, vpnCloudflareWARP},
		},
		{
			name: "darwin launchd labels",
			text: "com.tailscale.tailscaled\ncom.zerotier.one\ncom.cloudflare.1dot1dot1dot1.macos.warp.daemon",
			want: []string{vpnTailscale, vpnZeroTier, vpnCloudflareWARP},
		},
		{
			name: "none",
			text: "sshd\ncron\nnginx",
			want: nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := matchVPNServiceTokens(tt.text)
			for _, provider := range tt.want {
				if !got[provider] {
					t.Errorf("expected provider %q in %v", provider, got)
				}
			}
			if len(got) != len(tt.want) {
				t.Errorf("got %d providers %v, want %d %v", len(got), got, len(tt.want), tt.want)
			}
		})
	}
}
