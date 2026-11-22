//go:build linux

package netattach

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestCurrent_LinuxMatchesOS checks Current against what the OS says, read
// without any code under test: /proc/net/route (IPv4 default routes),
// /sys/class/net (hardware behind the interface), /proc/net/arp (the
// gateway's entry) and net.Interfaces (up, IPv4 addresses).
//
// It asserts only on a default route the package must report: up, with a
// gateway, on an up ethernet interface that has hardware behind it and an
// address K5 can pick. It skips when there is none: a container's veth has no
// sysfs device, so K1 leaves it out by design, and that rule is not this
// test's subject.
//
// It is read-only, needs no privilege and sends no packet (the primary check
// connects a UDP socket, which only asks the kernel for a route). CI logs are
// public: no address or MAC is printed, passing or failing.
func TestCurrent_LinuxMatchesOS(t *testing.T) {
	const server = "203.0.113.20"

	routes, specific, err := procRoutes("/proc/net/route")
	if err != nil {
		t.Skipf("cannot read /proc/net/route: %v", redact(err.Error()))
	}
	links, err := net.Interfaces()
	if err != nil {
		t.Skipf("net.Interfaces: %v", redact(err.Error()))
	}
	byName := map[string]net.Interface{}
	for _, l := range links {
		byName[l.Name] = l
	}

	var want []osRoute
	for _, r := range routes {
		l, ok := byName[r.iface]
		switch {
		case !ok:
			t.Logf("default route on %s: interface not listed, not checked", r.iface)
		case l.Flags&net.FlagUp == 0:
			t.Logf("default route on %s: interface down, not checked", r.iface)
		case !usableGateway(r.gateway):
			t.Logf("default route on %s: gateway is not a unicast LAN address (K5 skips it), not checked", r.iface)
		default:
			why := hardwareEthernet("/sys/class/net", r.iface)
			if why != "" {
				t.Logf("default route on %s: %s, not checked", r.iface, why)
				continue
			}
			r.addrs = ipv4Prefixes(t, l)
			if !k5Pickable(r.addrs, r.gateway) {
				t.Logf("default route on %s: no IPv4 address K5 can pick, not checked", r.iface)
				continue
			}
			want = append(want, r)
		}
	}
	if len(want) == 0 {
		t.Skipf("no IPv4 default route with a gateway on an up, addressed, hardware-backed ethernet interface (%d default routes seen); a container's own interface has no sysfs device and K1 leaves it out by design", len(routes))
	}
	if len(want) > MaxAttachments {
		t.Skipf("%d qualifying default routes, more than MaxAttachments: the list is cut by design", len(want))
	}

	arpBefore, arpErr := procARP("/proc/net/arp")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	got, complete, err := Current(ctx, server)
	arpAfter, arpErr2 := procARP("/proc/net/arp")

	if err != nil {
		t.Errorf("Current: err = %v, want nil", redact(err.Error()))
	}
	if !complete {
		t.Errorf("Current: complete = false, want true")
	}
	for _, a := range got {
		t.Logf("returned: if=%s local=%v gateway=%v mac=%v primary=%v",
			a.InterfaceName, a.LocalAddress.IsValid(), a.GatewayAddress.IsValid(), a.GatewayMAC != nil, a.Primary)
	}

	for _, r := range want {
		var match *Attachment
		for i := range got {
			if got[i].InterfaceName == r.iface && got[i].GatewayAddress == r.gateway {
				match = &got[i]
				break
			}
		}
		if match == nil {
			t.Errorf("%s: no attachment with the default route's gateway (%d returned)", r.iface, len(got))
			continue
		}
		t.Logf("%s: attachment with the default route's gateway: yes", r.iface)
		if hasAddr(r.addrs, match.LocalAddress, int(match.PrefixLength)) {
			t.Logf("%s: local address is one of the interface's: yes", r.iface)
		} else {
			t.Errorf("%s: local address/prefix is not one of the interface's IPv4 addresses", r.iface)
		}

		key := arpKey{r.gateway, r.iface}
		before, okBefore := arpBefore[key]
		after, okAfter := arpAfter[key]
		switch {
		case arpErr != nil || arpErr2 != nil:
			t.Logf("%s: /proc/net/arp unreadable, MAC not checked", r.iface)
		case !okBefore || !okAfter:
			t.Logf("%s: no complete gateway entry in /proc/net/arp (before=%v after=%v), MAC not checked", r.iface, okBefore, okAfter)
		case !bytes.Equal(before, after):
			t.Logf("%s: gateway entry changed during the read, MAC not checked", r.iface)
		case before[0]&0x01 != 0:
			t.Logf("%s: gateway entry is a group address (never reported), MAC not checked", r.iface)
		case bytes.Equal(before, net.HardwareAddr{0x02, 0, 0, 0, 0, 0}):
			t.Logf("%s: gateway entry is the 02:00:00:00:00:00 placeholder (never reported), MAC not checked", r.iface)
		case match.GatewayMAC == nil:
			t.Errorf("%s: gateway MAC missing; /proc/net/arp has a complete entry", r.iface)
		case !bytes.Equal(match.GatewayMAC, before):
			t.Errorf("%s: gateway MAC differs from the /proc/net/arp entry", r.iface)
		default:
			t.Logf("%s: gateway MAC equals the /proc/net/arp entry: yes", r.iface)
		}
	}

	if len(want) == 1 {
		r := want[0]
		src, ok := kernelSource(server)
		serverAddr := netip.MustParseAddr(server)
		covered := false
		for _, p := range specific {
			covered = covered || p.Contains(serverAddr)
		}
		switch {
		case covered:
			t.Logf("%s: a more specific route covers the server, primary not checked", r.iface)
		case !ok:
			t.Logf("%s: kernel has no route to the server, primary not checked", r.iface)
		case !hasAddr(r.addrs, src, -1):
			t.Logf("%s: kernel routes the server through another interface (policy routing or a VPN), primary not checked", r.iface)
		default:
			for _, a := range got {
				if a.InterfaceName != r.iface || a.GatewayAddress != r.gateway {
					continue
				}
				if a.Primary {
					t.Logf("%s: primary: yes", r.iface)
				} else {
					t.Errorf("%s: the only qualifying default route, which carries the server route, is not primary", r.iface)
				}
			}
		}
	}
}

type osRoute struct {
	iface   string
	gateway netip.Addr
	addrs   []netip.Prefix
}

const (
	rtfUp      = 0x0001
	rtfGateway = 0x0002
	rtfReject  = 0x0200
)

// procRoutes reads the main table: its IPv4 default routes that are up, have
// a gateway and are not reject routes, and the prefixes of every other route.
func procRoutes(path string) ([]osRoute, []netip.Prefix, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	var out []osRoute
	var specific []netip.Prefix
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 8 {
			continue
		}
		dst, e1 := strconv.ParseUint(fields[1], 16, 32)
		gw, e2 := strconv.ParseUint(fields[2], 16, 32)
		flags, e3 := strconv.ParseUint(fields[3], 16, 32)
		mask, e4 := strconv.ParseUint(fields[7], 16, 32)
		if err := errors.Join(e1, e2, e3, e4); err != nil {
			return nil, nil, errors.New("unparsable /proc/net/route row")
		}
		if mask != 0 {
			m := procWord(mask).As4()
			bits := 0
			for bits < 32 && m[bits/8]&(0x80>>(bits%8)) != 0 {
				bits++
			}
			specific = append(specific, netip.PrefixFrom(procWord(dst), bits))
			continue
		}
		if dst != 0 || flags&(rtfUp|rtfGateway) != rtfUp|rtfGateway || flags&rtfReject != 0 {
			continue
		}
		out = append(out, osRoute{iface: fields[0], gateway: procWord(gw)})
	}
	return out, specific, sc.Err()
}

// procWord decodes a /proc/net/route address: the kernel prints the
// network-order word as a host-order integer.
func procWord(v uint64) netip.Addr {
	var b [4]byte
	binary.NativeEndian.PutUint32(b[:], uint32(v))
	return netip.AddrFrom4(b)
}

func usableGateway(gw netip.Addr) bool {
	return gw.Is4() && !gw.IsLoopback() && !gw.IsLinkLocalUnicast() && !gw.IsMulticast() &&
		!gw.IsUnspecified() && gw != netip.AddrFrom4([4]byte{255, 255, 255, 255})
}

// hardwareEthernet returns "" when sysfs shows an ethernet interface with a
// device behind it (hardware, or a VM's virtual hardware) and no tunnel or
// bridge marker; otherwise the reason it is not checked.
func hardwareEthernet(root, name string) string {
	dir := filepath.Join(root, name)
	if _, err := os.Lstat(filepath.Join(dir, "device")); err != nil {
		return "no sysfs device (virtual interface)"
	}
	raw, err := os.ReadFile(filepath.Join(dir, "type"))
	if err != nil || strings.TrimSpace(string(raw)) != "1" {
		return "link type is not ethernet"
	}
	if _, err := os.Lstat(filepath.Join(dir, "tun_flags")); err == nil {
		return "tun/tap device"
	}
	if uevent, err := os.ReadFile(filepath.Join(dir, "uevent")); err == nil {
		for _, line := range strings.Split(string(uevent), "\n") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(line), "DEVTYPE="); ok && v != "wlan" {
				return "device type " + v
			}
		}
	}
	return ""
}

func ipv4Prefixes(t *testing.T, l net.Interface) []netip.Prefix {
	addrs, err := l.Addrs()
	if err != nil {
		t.Logf("%s: addresses unreadable: %v", l.Name, redact(err.Error()))
		return nil
	}
	var out []netip.Prefix
	for _, a := range addrs {
		ipn, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipn.IP)
		if !ok {
			continue
		}
		ip = ip.Unmap()
		if !ip.Is4() {
			continue
		}
		ones, _ := ipn.Mask.Size()
		out = append(out, netip.PrefixFrom(ip, ones))
	}
	return out
}

// k5Pickable: an address whose prefix holds the gateway, or one that is not
// link-local.
func k5Pickable(addrs []netip.Prefix, gw netip.Addr) bool {
	for _, p := range addrs {
		if p.Addr().IsLoopback() || p.Addr().IsMulticast() || p.Addr().IsUnspecified() {
			continue
		}
		if p.Masked().Contains(gw) || !p.Addr().IsLinkLocalUnicast() {
			return true
		}
	}
	return false
}

// hasAddr reports whether addr (with bits, or any prefix length when bits < 0)
// is one of addrs.
func hasAddr(addrs []netip.Prefix, addr netip.Addr, bits int) bool {
	for _, p := range addrs {
		if p.Addr() == addr && (bits < 0 || p.Bits() == bits) {
			return true
		}
	}
	return false
}

type arpKey struct {
	ip    netip.Addr
	iface string
}

const atfCom = 0x2

// procARP reads complete, non-zero 6-byte entries from /proc/net/arp.
func procARP(path string) (map[arpKey]net.HardwareAddr, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[arpKey]net.HardwareAddr{}
	sc := bufio.NewScanner(f)
	sc.Scan() // header
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 6 {
			continue
		}
		ip, err := netip.ParseAddr(fields[0])
		if err != nil {
			continue
		}
		flags, err := strconv.ParseUint(strings.TrimPrefix(fields[2], "0x"), 16, 32)
		if err != nil || flags&atfCom == 0 {
			continue
		}
		mac, err := net.ParseMAC(fields[3])
		if err != nil || len(mac) != 6 || bytes.Equal(mac, make(net.HardwareAddr, 6)) {
			continue
		}
		out[arpKey{ip, fields[5]}] = mac
	}
	return out, sc.Err()
}

// kernelSource asks the kernel which local address it would use for dest.
// Connecting a UDP socket only runs the route lookup; nothing is sent.
func kernelSource(dest string) (netip.Addr, bool) {
	c, err := net.Dial("udp4", net.JoinHostPort(dest, "9"))
	if err != nil {
		return netip.Addr{}, false
	}
	defer c.Close()
	ua, ok := c.LocalAddr().(*net.UDPAddr)
	if !ok {
		return netip.Addr{}, false
	}
	ip, ok := netip.AddrFromSlice(ua.IP)
	return ip.Unmap(), ok
}

var (
	ipv4Text = regexp.MustCompile(`\b\d{1,3}(\.\d{1,3}){3}\b`)
	hexColon = regexp.MustCompile(`(?i)\b[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,}\b`)
)

// redact removes anything that looks like an address or MAC from s.
func redact(s string) string {
	return hexColon.ReplaceAllString(ipv4Text.ReplaceAllString(s, "<addr>"), "<addr>")
}
