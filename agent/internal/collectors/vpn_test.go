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
	noAttr := func() map[string]string { return nil }

	t.Run("skips down interfaces and non-tunnels", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "eth0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.0.0.5/24"}}},
			{Name: "wg0", Flags: []string{"broadcast"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}}, // down
		}
		if got := assembleVPNs(ifaces, map[string]string{}, noDNS, noAttr); len(got) != 0 {
			t.Fatalf("expected no VPNs, got %+v", got)
		}
	})

	t.Run("skips up tunnel with no overlay IP (phantom guard)", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun4", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "fe80::1/64"}}}, // link-local only
		}
		if got := assembleVPNs(ifaces, map[string]string{}, noDNS, noAttr); len(got) != 0 {
			t.Fatalf("expected phantom tunnel skipped, got %+v", got)
		}
	})

	t.Run("classified provider keeps interface source with no signals", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}},
		}
		got := assembleVPNs(ifaces, map[string]string{}, noDNS, noAttr)
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
		got := assembleVPNs(ifaces, map[string]string{vpnWireGuard: vpnSourceService}, noDNS, noAttr)
		if len(got) != 1 || got[0].DetectionSource != vpnSourceService {
			t.Fatalf("expected source upgraded to service, got %+v", got)
		}
	})

	t.Run("generic tunnel promoted to sole signal provider", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun3", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}},
		}
		got := assembleVPNs(ifaces, map[string]string{vpnOpenVPN: vpnSourceProcess}, noDNS, noAttr)
		if len(got) != 1 || got[0].Provider != vpnOpenVPN || got[0].DetectionSource != vpnSourceProcess {
			t.Fatalf("expected generic promoted to openvpn/process, got %+v", got)
		}
	})

	t.Run("generic tunnel stays generic when signals ambiguous", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun3", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}},
		}
		signals := map[string]string{vpnOpenVPN: vpnSourceProcess, vpnWireGuard: vpnSourceService}
		got := assembleVPNs(ifaces, signals, noDNS, noAttr)
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
		got := assembleVPNs(ifaces, map[string]string{}, dnsFn, noAttr)
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
		assembleVPNs(ifaces, map[string]string{}, dnsFn, noAttr)
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

// Inactive reporting (#2139): a VPN client that is running with no tunnel up
// must appear as an inactive entry instead of vanishing from the list.
func TestAssembleVPNsInactiveReporting(t *testing.T) {
	noDNS := func() string { return "" }
	noAttr := func() map[string]string { return nil }
	upWG := psnet.InterfaceStat{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}}

	tests := []struct {
		name    string
		ifaces  []psnet.InterfaceStat
		signals map[string]string
		attrs   map[string]string
		want    []VpnPresence
	}{
		{
			name:    "running client with no tunnel reports inactive",
			signals: map[string]string{vpnNetBird: vpnSourceService},
			want: []VpnPresence{
				{Provider: vpnNetBird, Active: false, DetectionSource: vpnSourceService},
			},
		},
		{
			name:    "no signals reports nothing (no phantoms)",
			signals: map[string]string{},
			want:    nil,
		},
		{
			name:    "connected provider is not also reported inactive",
			ifaces:  []psnet.InterfaceStat{upWG},
			signals: map[string]string{vpnWireGuard: vpnSourceService},
			want: []VpnPresence{
				{Provider: vpnWireGuard, Active: true, InterfaceName: "wg0", IPv4: "10.8.0.2", DetectionSource: vpnSourceService},
			},
		},
		{
			name:    "connected provider plus a disconnected sibling",
			ifaces:  []psnet.InterfaceStat{upWG},
			signals: map[string]string{vpnWireGuard: vpnSourceService, vpnZeroTier: vpnSourceProcess},
			want: []VpnPresence{
				{Provider: vpnWireGuard, Active: true, InterfaceName: "wg0", IPv4: "10.8.0.2", DetectionSource: vpnSourceService},
				{Provider: vpnZeroTier, Active: false, DetectionSource: vpnSourceProcess},
			},
		},
		{
			name:    "inactive entries are sorted for a stable snapshot",
			signals: map[string]string{vpnZeroTier: vpnSourceProcess, vpnNetBird: vpnSourceService, vpnOpenVPN: vpnSourceProcess},
			want: []VpnPresence{
				{Provider: vpnNetBird, Active: false, DetectionSource: vpnSourceService},
				{Provider: vpnOpenVPN, Active: false, DetectionSource: vpnSourceProcess},
				{Provider: vpnZeroTier, Active: false, DetectionSource: vpnSourceProcess},
			},
		},
		{
			name:    "generic signal never becomes an inactive entry",
			signals: map[string]string{vpnGeneric: vpnSourceProcess},
			want:    nil,
		},
		{
			name: "unattributed tunnel suppresses inactive claims entirely",
			// utun3 is up but nothing ties it to a provider, so it could be
			// either running client's tunnel — calling either disconnected
			// would be a guess.
			ifaces:  []psnet.InterfaceStat{{Name: "utun3", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}}},
			signals: map[string]string{vpnNetBird: vpnSourceService, vpnWireGuard: vpnSourceService},
			want: []VpnPresence{
				{Provider: vpnGeneric, Active: true, InterfaceName: "utun3", IPv4: "100.64.0.1", DetectionSource: vpnSourceInterface},
			},
		},
		{
			name: "attributed tunnel still allows inactive claims for the others",
			ifaces: []psnet.InterfaceStat{
				{Name: "utun6", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.95.194.59/32"}}},
			},
			signals: map[string]string{vpnTailscale: vpnSourceService, vpnNetBird: vpnSourceService},
			attrs:   map[string]string{"utun6": vpnTailscale},
			want: []VpnPresence{
				{Provider: vpnTailscale, Active: true, InterfaceName: "utun6", IPv4: "100.95.194.59", DetectionSource: vpnSourceAdapter},
				{Provider: vpnNetBird, Active: false, DetectionSource: vpnSourceService},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			attrFn := noAttr
			if tt.attrs != nil {
				attrFn = func() map[string]string { return tt.attrs }
			}
			got := assembleVPNs(tt.ifaces, tt.signals, noDNS, attrFn)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d entries %+v, want %d %+v", len(got), got, len(tt.want), tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Errorf("entry %d = %+v, want %+v", i, got[i], tt.want[i])
				}
			}
		})
	}
}

// Per-interface attribution (#2139 gap 2): a Mac running several VPN clients at
// once can name each tunnel from its owning network extension, where the global
// "exactly one client running" rule refuses to promote.
func TestAssembleVPNsInterfaceAttribution(t *testing.T) {
	noDNS := func() string { return "" }

	t.Run("multi-VPN mac names each attributed tunnel", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun6", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.95.194.59/32"}}},
			{Name: "utun8", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.4/32"}}},
		}
		// Both clients running: soleVPNSignal would refuse (count 2).
		signals := map[string]string{vpnTailscale: vpnSourceService, vpnWireGuard: vpnSourceService}
		attrs := map[string]string{"utun6": vpnTailscale, "utun8": vpnWireGuard}
		got := assembleVPNs(ifaces, signals, noDNS, func() map[string]string { return attrs })
		if len(got) != 2 {
			t.Fatalf("expected 2 VPNs, got %+v", got)
		}
		if got[0].Provider != vpnTailscale || got[0].DetectionSource != vpnSourceAdapter {
			t.Errorf("utun6 = %+v, want tailscale/adapter", got[0])
		}
		if got[1].Provider != vpnWireGuard || got[1].DetectionSource != vpnSourceAdapter {
			t.Errorf("utun8 = %+v, want wireguard/adapter", got[1])
		}
	})

	t.Run("attribution wins over an ambiguous sole-signal fallback", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun6", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.95.194.59/32"}}},
		}
		// Only openvpn is running, so soleVPNSignal would have said openvpn —
		// the concrete per-interface evidence must take precedence.
		signals := map[string]string{vpnOpenVPN: vpnSourceProcess}
		attrs := map[string]string{"utun6": vpnTailscale}
		got := assembleVPNs(ifaces, signals, noDNS, func() map[string]string { return attrs })
		if len(got) == 0 || got[0].Provider != vpnTailscale || got[0].DetectionSource != vpnSourceAdapter {
			t.Fatalf("expected adapter attribution to win, got %+v", got)
		}
	})

	t.Run("unattributed interface falls back to sole signal", func(t *testing.T) {
		ifaces := []psnet.InterfaceStat{
			{Name: "utun7", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.4/32"}}},
		}
		attrs := map[string]string{"utun6": vpnTailscale}
		got := assembleVPNs(ifaces, map[string]string{vpnWireGuard: vpnSourceProcess}, noDNS, func() map[string]string { return attrs })
		if len(got) != 1 || got[0].Provider != vpnWireGuard || got[0].DetectionSource != vpnSourceProcess {
			t.Fatalf("expected sole-signal fallback, got %+v", got)
		}
	})

	t.Run("attrFn fetched at most once and only for generic tunnels", func(t *testing.T) {
		calls := 0
		attrFn := func() map[string]string { calls++; return nil }
		ifaces := []psnet.InterfaceStat{
			{Name: "wg0", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "10.8.0.2/32"}}},
		}
		assembleVPNs(ifaces, map[string]string{}, noDNS, attrFn)
		if calls != 0 {
			t.Fatalf("expected attrFn not called for named interfaces, got %d", calls)
		}
		ifaces = append(ifaces,
			psnet.InterfaceStat{Name: "utun3", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.1/32"}}},
			psnet.InterfaceStat{Name: "utun4", Flags: []string{"up"}, Addrs: []psnet.InterfaceAddr{{Addr: "100.64.0.2/32"}}},
		)
		assembleVPNs(ifaces, map[string]string{}, noDNS, attrFn)
		if calls != 1 {
			t.Errorf("expected attrFn called once for two generic tunnels, got %d", calls)
		}
	})
}

func TestParseIfconfigVPNAgents(t *testing.T) {
	// Real `ifconfig -v` output shape from macOS 15 (trimmed).
	const sample = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384 index 1
	inet 127.0.0.1 netmask 0xff000000
utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280 index 24
	inet 100.95.194.59 --> 100.95.194.59 netmask 0xffffffff
	agent domain:Skywalk type:NetIf flags:0x8443 desc:"Userspace Networking"
	agent domain:NetworkExtension type:VPN flags:0x3 desc:"VPN: Tailscale 3"
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500 index 43
	agent domain:NetworkExtension type:VPN flags:0xf desc:"VPN: NextDNS"
utun0: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1500 index 25
	agent domain:com.apple.rapport type:RapportNetworkAgent flags:0x7c3 desc:"Rapport Network Agent"
utun8: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1420 index 46
	agent domain:NetworkExtension type:VPN flags:0x3 desc:"VPN: WireGuard: home"
utun9: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1420 index 47
	agent domain:NetworkExtension type:VPN flags:0x3 desc:"VPN: Tailscale via WireGuard"
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500 index 14
	inet 192.168.1.10 netmask 0xffffff00 broadcast 192.168.1.255
`

	got := parseIfconfigVPNAgents(sample)
	want := map[string]string{
		"utun6": vpnTailscale,
		"utun8": vpnWireGuard,
	}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for iface, provider := range want {
		if got[iface] != provider {
			t.Errorf("%s = %q, want %q", iface, got[iface], provider)
		}
	}

	t.Run("empty output", func(t *testing.T) {
		if got := parseIfconfigVPNAgents(""); len(got) != 0 {
			t.Errorf("expected no attributions, got %v", got)
		}
	})

	t.Run("agent line without an interface header is ignored", func(t *testing.T) {
		got := parseIfconfigVPNAgents("\tagent domain:NetworkExtension type:VPN flags:0x3 desc:\"VPN: Tailscale\"\n")
		if len(got) != 0 {
			t.Errorf("expected no attributions, got %v", got)
		}
	})
}
