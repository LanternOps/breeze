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

func TestAssembleVPNs(t *testing.T) {
	noDNS := func() string { return "" }

	t.Run("skips down interfaces and non-tunnels", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "eth0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.0.0.5/24"}}},
			{Name: "wg0", Flags: []string{"broadcast"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}}, // down
		}
		if got := assembleVPNs(ifaces, map[string]string{}, noDNS); len(got) != 0 {
			t.Fatalf("expected no VPNs, got %+v", got)
		}
	})

	t.Run("skips up tunnel with no overlay IP (phantom guard)", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun4", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "fe80::1/64"}}}, // link-local only
		}
		if got := assembleVPNs(ifaces, map[string]string{}, noDNS); len(got) != 0 {
			t.Fatalf("expected phantom tunnel skipped, got %+v", got)
		}
	})

	t.Run("classified provider keeps interface source with no signals", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}},
		}
		got := assembleVPNs(ifaces, map[string]string{}, noDNS)
		if len(got) != 1 || got[0].Provider != vpnWireGuard || got[0].DetectionSource != vpnSourceInterface {
			t.Fatalf("got %+v", got)
		}
		if got[0].IPv4 != "10.8.0.2" || !got[0].Active {
			t.Errorf("unexpected fields %+v", got[0])
		}
	})

	t.Run("classified provider source upgraded by corroborating signal", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}},
		}
		got := assembleVPNs(ifaces, map[string]string{vpnWireGuard: vpnSourceService}, noDNS)
		if len(got) != 1 || got[0].DetectionSource != vpnSourceService {
			t.Fatalf("expected source upgraded to service, got %+v", got)
		}
	})

	t.Run("generic tunnel promoted to sole signal provider", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun3", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}},
		}
		got := assembleVPNs(ifaces, map[string]string{vpnOpenVPN: vpnSourceProcess}, noDNS)
		if len(got) != 1 || got[0].Provider != vpnOpenVPN || got[0].DetectionSource != vpnSourceProcess {
			t.Fatalf("expected generic promoted to openvpn/process, got %+v", got)
		}
	})

	t.Run("generic tunnel stays generic when signals ambiguous", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun3", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}},
		}
		signals := map[string]string{vpnOpenVPN: vpnSourceProcess, vpnWireGuard: vpnSourceService}
		got := assembleVPNs(ifaces, signals, noDNS)
		if len(got) != 1 || got[0].Provider != vpnGeneric || got[0].DetectionSource != vpnSourceInterface {
			t.Fatalf("expected generic/interface when ambiguous, got %+v", got)
		}
	})

	t.Run("tailscale DNS fetched once and attached only to tailscale", func(t *testing.T) {
		calls := 0
		dnsFn := func() string { calls++; return "host.tailnet.ts.net" }
		ifaces := []psnet.InterfaceStat{
			{Name: "tailscale0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}},
			{Name: "tailscale1", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.2/32"}}},
			{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}},
		}
		got := assembleVPNs(ifaces, map[string]string{}, dnsFn)
		if len(got) != 3 {
			t.Fatalf("expected 3 VPNs, got %d", len(got))
		}
		if calls != 1 {
			t.Errorf("expected dnsFn called once, got %d", calls)
		}
		for _, v := range got {
			if v.Provider == vpnTailscale && v.DNSName != "host.tailnet.ts.net" {
				t.Errorf("tailscale entry missing DNS name: %+v", v)
			}
			if v.Provider == vpnWireGuard && v.DNSName != "" {
				t.Errorf("non-tailscale entry should not carry DNS name: %+v", v)
			}
		}
	})

	t.Run("dnsFn not called when no tailscale present", func(t *testing.T) {
		calls := 0
		dnsFn := func() string { calls++; return "x" }
		ifaces := []psnet.InterfaceStat{
			{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}},
		}
		assembleVPNs(ifaces, map[string]string{}, dnsFn)
		if calls != 0 {
			t.Errorf("expected dnsFn not called, got %d", calls)
		}
	})
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
