package networkcontext

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Interface kinds (#7819). The server classifies a network by the kind of the
// interface it was observed on before falling back to CIDR guesses, so a VPN on
// RFC1918 is an overlay and a genuine CGNAT LAN stays a LAN. Every mapper here
// is pure and answers only with a kind the server's interface-row enum accepts;
// anything it cannot tell for certain is "unknown", which keeps the CIDR fallback.
var reportedInterfaceKinds = map[string]bool{"ethernet": true, "wifi": true, "tunnel": true, "bridge": true, "cellular": true, "virtual": true, "other": true, "unknown": true}

// reportableInterfaceKind keeps a probe's answer inside the wire enum: an
// unexpected value would invalidate the whole report, so it becomes "unknown".
func reportableInterfaceKind(kind string) string {
	if reportedInterfaceKinds[kind] {
		return kind
	}
	return "unknown"
}

// Linux link-layer types (include/uapi/linux/if_arp.h).
const (
	arphrdEther             = 1
	arphrdPPP               = 512
	arphrdRawIP             = 519
	arphrdTunnel            = 768
	arphrdTunnel6           = 769
	arphrdLoopback          = 772
	arphrdSit               = 776
	arphrdIPGRE             = 778
	arphrdIEEE80211         = 801
	arphrdIEEE80211Prism    = 802
	arphrdIEEE80211Radiotap = 803
	arphrdIP6GRE            = 823
	arphrdNone              = 0xfffe
)

// linuxLinkFacts is the read-only sysfs evidence for one interface.
type linuxLinkFacts struct {
	ARPHRD   int    // /sys/class/net/<if>/type; -1 when unreadable
	DevType  string // DEVTYPE= in /sys/class/net/<if>/uevent (wlan, bridge, wireguard, vxlan, ...)
	TunTap   bool   // /sys/class/net/<if>/tun_flags exists: a tun or tap device
	Hardware bool   // /sys/class/net/<if>/device exists: backed by a bus device
}

// linuxInterfaceKind maps sysfs evidence to a kind. DEVTYPE is the most specific
// signal, then the link type; an Ethernet-typed link is a TAP tunnel, a NIC, or
// (with no backing device) a software link such as veth/macvlan/dummy.
func linuxInterfaceKind(f linuxLinkFacts) string {
	switch f.DevType {
	case "wlan":
		return "wifi"
	case "bridge":
		return "bridge"
	case "wwan":
		return "cellular"
	case "wireguard", "vxlan", "geneve":
		return "tunnel"
	case "vlan", "bond":
		return "ethernet"
	}
	switch f.ARPHRD {
	case -1:
		return "unknown"
	case arphrdNone, arphrdPPP, arphrdTunnel, arphrdTunnel6, arphrdSit, arphrdIPGRE, arphrdIP6GRE:
		return "tunnel"
	case arphrdRawIP:
		return "cellular"
	case arphrdIEEE80211, arphrdIEEE80211Prism, arphrdIEEE80211Radiotap:
		return "wifi"
	case arphrdEther:
		switch {
		case f.TunTap:
			return "tunnel"
		case f.Hardware:
			return "ethernet"
		default:
			return "virtual"
		}
	}
	return "other"
}

// readLinuxLinkFacts reads root/<name>/{type,uevent,tun_flags,device}. It only
// reads; a name that is not a single path element, or any read failure, yields
// ARPHRD -1 (unknown) rather than a guess.
func readLinuxLinkFacts(root, name string) linuxLinkFacts {
	unknown := linuxLinkFacts{ARPHRD: -1}
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, `/\`) {
		return unknown
	}
	dir := filepath.Join(root, name)
	raw, err := os.ReadFile(filepath.Join(dir, "type"))
	if err != nil {
		return unknown
	}
	arphrd, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || arphrd < 0 {
		return unknown
	}
	facts := linuxLinkFacts{ARPHRD: arphrd}
	if uevent, err := os.ReadFile(filepath.Join(dir, "uevent")); err == nil {
		for _, line := range strings.Split(string(uevent), "\n") {
			if value, ok := strings.CutPrefix(strings.TrimSpace(line), "DEVTYPE="); ok {
				facts.DevType = value
			}
		}
	}
	if _, err := os.Lstat(filepath.Join(dir, "tun_flags")); err == nil {
		facts.TunTap = true
	}
	if _, err := os.Lstat(filepath.Join(dir, "device")); err == nil {
		facts.Hardware = true
	}
	return facts
}

// darwinInterfaceKind uses the kernel's fixed interface-name families: utun
// (Network Extension VPNs, WireGuard, Tailscale), ipsec, ppp, gif, stf and
// tun/tap are tunnels; bridgeN is a bridge. en* is Ethernet or Wi-Fi (both
// IFT_ETHER) and stays unknown, as does any name without a unit number.
func darwinInterfaceKind(name string) string {
	family := strings.TrimRight(name, "0123456789")
	if family == "" || family == name {
		return "unknown"
	}
	switch family {
	case "utun", "ipsec", "ppp", "gif", "stf", "tun", "tap":
		return "tunnel"
	case "bridge":
		return "bridge"
	}
	return "unknown"
}

// windowsInterfaceKind maps IP_ADAPTER_ADDRESSES.IfType (ipifcons.h). RAS VPN
// connections (SSTP/L2TP/IKEv2/PPTP) are IF_TYPE_PPP; Wintun (WireGuard,
// Tailscale) is IF_TYPE_PROP_VIRTUAL with no link-layer address, which cannot
// be a LAN segment. A virtual adapter that has a MAC stays "virtual".
// IF_TYPE_ETHERNET_CSMACD is also what TAP-style VPN adapters (OpenVPN
// TAP-Windows, many vendor VPN miniports) and Hyper-V vEthernet report, so it
// is "ethernet" (link evidence, which switches off the server's CGNAT guess)
// only when Windows marks it a hardware interface; otherwise "virtual", which
// leaves the CIDR fallback in charge.
func windowsInterfaceKind(ifType uint32, hasLinkAddress, hardware bool) string {
	switch ifType {
	case 6: // IF_TYPE_ETHERNET_CSMACD
		if hardware {
			return "ethernet"
		}
		return "virtual"
	case 71: // IF_TYPE_IEEE80211
		return "wifi"
	case 23, 131: // IF_TYPE_PPP, IF_TYPE_TUNNEL
		return "tunnel"
	case 53: // IF_TYPE_PROP_VIRTUAL
		if !hasLinkAddress {
			return "tunnel"
		}
		return "virtual"
	case 243, 244: // IF_TYPE_WWANPP, IF_TYPE_WWANPP2
		return "cellular"
	}
	return "other"
}
