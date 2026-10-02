package networkcontext

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// reportableKinds mirrors the server's interface-row enum (TOPOLOGY_INTERFACE_KINDS);
// a kind outside it would make the whole report invalid.
var reportableKinds = map[string]bool{"ethernet": true, "wifi": true, "tunnel": true, "bridge": true, "cellular": true, "virtual": true, "other": true, "unknown": true}

func TestLinuxInterfaceKind(t *testing.T) {
	tests := []struct {
		name  string
		facts linuxLinkFacts
		want  string
	}{
		{"no sysfs evidence", linuxLinkFacts{ARPHRD: -1}, "unknown"},
		{"wireguard / tailscale / openvpn tun (no link layer)", linuxLinkFacts{ARPHRD: arphrdNone, TunTap: true}, "tunnel"},
		{"wireguard by devtype", linuxLinkFacts{ARPHRD: arphrdNone, DevType: "wireguard"}, "tunnel"},
		{"ppp", linuxLinkFacts{ARPHRD: arphrdPPP}, "tunnel"},
		{"ipip", linuxLinkFacts{ARPHRD: arphrdTunnel}, "tunnel"},
		{"ip6tnl", linuxLinkFacts{ARPHRD: arphrdTunnel6}, "tunnel"},
		{"sit", linuxLinkFacts{ARPHRD: arphrdSit}, "tunnel"},
		{"gre", linuxLinkFacts{ARPHRD: arphrdIPGRE}, "tunnel"},
		{"ip6gre", linuxLinkFacts{ARPHRD: arphrdIP6GRE}, "tunnel"},
		{"vxlan overlay", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "vxlan"}, "tunnel"},
		{"geneve overlay", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "geneve"}, "tunnel"},
		{"openvpn tap", linuxLinkFacts{ARPHRD: arphrdEther, TunTap: true}, "tunnel"},
		{"physical nic", linuxLinkFacts{ARPHRD: arphrdEther, Hardware: true}, "ethernet"},
		{"wifi", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "wlan", Hardware: true}, "wifi"},
		{"wifi monitor link type", linuxLinkFacts{ARPHRD: arphrdIEEE80211Radiotap}, "wifi"},
		{"bridge", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "bridge"}, "bridge"},
		{"vlan on a nic", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "vlan"}, "ethernet"},
		{"bond", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "bond"}, "ethernet"},
		{"wwan raw ip", linuxLinkFacts{ARPHRD: arphrdRawIP}, "cellular"},
		{"wwan framework (ARPHRD_NONE) is cellular, not a tunnel", linuxLinkFacts{ARPHRD: arphrdNone, DevType: "wwan"}, "cellular"},
		{"veth / macvlan / dummy", linuxLinkFacts{ARPHRD: arphrdEther}, "virtual"},
		{"loopback", linuxLinkFacts{ARPHRD: arphrdLoopback}, "other"},
		{"infiniband", linuxLinkFacts{ARPHRD: 32}, "other"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := linuxInterfaceKind(tt.facts)
			if got != tt.want || !reportableKinds[got] {
				t.Fatalf("linuxInterfaceKind(%+v) = %q, want %q", tt.facts, got, tt.want)
			}
		})
	}
}

func TestReadLinuxLinkFacts(t *testing.T) {
	root := t.TempDir()
	mk := func(name string, files map[string]string, dirs ...string) {
		for file, body := range files {
			p := filepath.Join(root, name, file)
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		for _, dir := range dirs {
			if err := os.MkdirAll(filepath.Join(root, name, dir), 0o755); err != nil {
				t.Fatal(err)
			}
		}
	}
	mk("wg0", map[string]string{"type": "65534\n", "uevent": "DEVTYPE=wireguard\nINTERFACE=wg0\nIFINDEX=5\n"})
	mk("tun0", map[string]string{"type": "65534\n", "uevent": "INTERFACE=tun0\nIFINDEX=6\n", "tun_flags": "0x1001\n"})
	mk("wlan0", map[string]string{"type": "1\n", "uevent": "DEVTYPE=wlan\nINTERFACE=wlan0\n"}, "device")
	mk("eth0", map[string]string{"type": "1\n", "uevent": "INTERFACE=eth0\n"}, "device")
	mk("veth1", map[string]string{"type": "1\n", "uevent": "INTERFACE=veth1\n"})
	mk("garbage", map[string]string{"type": "not-a-number\n"})

	tests := []struct {
		iface string
		want  linuxLinkFacts
		kind  string
	}{
		{"wg0", linuxLinkFacts{ARPHRD: arphrdNone, DevType: "wireguard"}, "tunnel"},
		{"tun0", linuxLinkFacts{ARPHRD: arphrdNone, TunTap: true}, "tunnel"},
		{"wlan0", linuxLinkFacts{ARPHRD: arphrdEther, DevType: "wlan", Hardware: true}, "wifi"},
		{"eth0", linuxLinkFacts{ARPHRD: arphrdEther, Hardware: true}, "ethernet"},
		{"veth1", linuxLinkFacts{ARPHRD: arphrdEther}, "virtual"},
		{"garbage", linuxLinkFacts{ARPHRD: -1}, "unknown"},
		{"vanished", linuxLinkFacts{ARPHRD: -1}, "unknown"},
		// Names never escape the sysfs directory.
		{"..", linuxLinkFacts{ARPHRD: -1}, "unknown"},
		{"../wg0", linuxLinkFacts{ARPHRD: -1}, "unknown"},
		{"", linuxLinkFacts{ARPHRD: -1}, "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.iface, func(t *testing.T) {
			got := readLinuxLinkFacts(root, tt.iface)
			if got != tt.want {
				t.Fatalf("readLinuxLinkFacts(%q) = %+v, want %+v", tt.iface, got, tt.want)
			}
			if kind := linuxInterfaceKind(got); kind != tt.kind {
				t.Fatalf("kind(%q) = %q, want %q", tt.iface, kind, tt.kind)
			}
		})
	}
}

func TestDarwinInterfaceKind(t *testing.T) {
	tests := []struct{ name, want string }{
		{"utun0", "tunnel"}, {"utun12", "tunnel"}, {"ipsec0", "tunnel"}, {"ppp0", "tunnel"}, {"gif0", "tunnel"}, {"stf0", "tunnel"},
		{"tun0", "tunnel"}, {"tap3", "tunnel"},
		{"bridge0", "bridge"}, {"bridge100", "bridge"},
		// en* is Ethernet or Wi-Fi (both IFT_ETHER); without SystemConfiguration the kind stays unknown.
		{"en0", "unknown"}, {"en7", "unknown"}, {"awdl0", "unknown"}, {"llw0", "unknown"}, {"anpi0", "unknown"},
		// A prefix needs its unit number: never guess from a bare or custom name.
		{"utun", "unknown"}, {"utunnel0", "unknown"}, {"bridge", "unknown"}, {"", "unknown"}, {"0", "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := darwinInterfaceKind(tt.name); got != tt.want || !reportableKinds[got] {
				t.Fatalf("darwinInterfaceKind(%q) = %q, want %q", tt.name, got, tt.want)
			}
		})
	}
}

func TestWindowsInterfaceKind(t *testing.T) {
	tests := []struct {
		name     string
		ifType   uint32
		hasMAC   bool
		hardware bool
		want     string
	}{
		{"physical nic", 6, true, true, "ethernet"},
		{"tap vpn / vEthernet / vendor miniport is not link evidence", 6, true, false, "virtual"},
		{"wifi", 71, true, true, "wifi"},
		{"teredo / 6to4 / ip-https", 131, false, false, "tunnel"},
		{"ras vpn (sstp/l2tp/ikev2/pptp)", 23, false, false, "tunnel"},
		{"wintun (wireguard/tailscale): virtual with no link layer", 53, false, false, "tunnel"},
		{"virtual adapter with a mac", 53, true, false, "virtual"},
		{"mobile broadband", 243, false, true, "cellular"},
		{"mobile broadband cdma", 244, false, true, "cellular"},
		{"token ring", 9, true, true, "other"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := windowsInterfaceKind(tt.ifType, tt.hasMAC, tt.hardware); got != tt.want || !reportableKinds[got] {
				t.Fatalf("windowsInterfaceKind(%d, %v, %v) = %q, want %q", tt.ifType, tt.hasMAC, tt.hardware, got, tt.want)
			}
		})
	}
}

func TestInterfaceRowsReportsTheProbedKind(t *testing.T) {
	ids := NewInterfaceIdentities(func(s string) (string, error) { return "key-" + s[:3], nil })
	list := func() ([]net.Interface, error) {
		return []net.Interface{{Index: 2, Name: "wg0", Flags: net.FlagUp}, {Index: 3, Name: "eth0", Flags: net.FlagUp}}, nil
	}
	none := func(net.Interface) ([]net.Addr, error) { return nil, nil }
	kinds := map[string]string{"wg0": "tunnel", "eth0": "ethernet"}
	rows, _, err := interfaceRows(context.Background(), ids, list, none, func(i net.Interface) string { return kinds[i.Name] })
	if err != nil || len(rows) != 2 {
		t.Fatal(rows, err)
	}
	for _, row := range rows {
		if row.Kind != kinds[row.Name] {
			t.Fatalf("%s: kind %q, want %q", row.Name, row.Kind, kinds[row.Name])
		}
	}
	// No probe (or an out-of-enum answer) reports unknown, never an invalid kind.
	for _, probe := range []func(net.Interface) string{nil, func(net.Interface) string { return "wireguard" }} {
		rows, _, err = interfaceRows(context.Background(), ids, list, none, probe)
		if err != nil || len(rows) != 2 || rows[0].Kind != "unknown" || rows[1].Kind != "unknown" {
			t.Fatal(rows, err)
		}
	}
}
