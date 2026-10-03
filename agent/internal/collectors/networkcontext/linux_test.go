//go:build linux

package networkcontext

import (
	"context"
	"encoding/binary"
	"net"
	"syscall"
	"testing"
)

func linuxRouteFixture(index uint32, zone byte) syscall.NetlinkMessage {
	h := make([]byte, 12)
	h[0] = syscall.AF_INET6
	h[4] = 254
	h[7] = 1
	b := make([]byte, 4)
	binary.NativeEndian.PutUint32(b, index)
	h = appendLinuxAttr(h, 4, b)
	ip := make([]byte, 16)
	ip[0] = 0xfe
	ip[1] = 0x80
	ip[15] = zone
	h = appendLinuxAttr(h, 5, ip)
	return syscall.NetlinkMessage{Header: syscall.NlMsghdr{Type: syscall.RTM_NEWROUTE}, Data: h}
}
func TestLinuxScopedRoutes(t *testing.T) {
	rows, e := parseLinuxRoutes([]syscall.NetlinkMessage{linuxRouteFixture(2, 1), linuxRouteFixture(3, 1)}, map[int]string{2: "if2", 3: "if3"})
	if e != nil || len(rows) != 2 {
		t.Fatal(rows, e)
	}
	if rows[0].TableKey != "254" || *rows[0].NextHops[0].Zone == *rows[1].NextHops[0].Zone {
		t.Fatal(rows)
	}
}
func TestMalformedNetlinkNeverComplete(t *testing.T) {
	for _, raw := range [][]byte{{1}, {0, 0, 1, 0}, {8, 0, 1, 0}} {
		if _, e := linuxAttrs(raw); e == nil {
			t.Fatalf("accepted %v", raw)
		}
	}
	rows, e := parseLinuxRoutes([]syscall.NetlinkMessage{{Header: syscall.NlMsghdr{Type: syscall.RTM_NEWROUTE}, Data: []byte{1}}}, nil)
	if e == nil || len(rows) != 0 {
		t.Fatal(rows, e)
	}
}
func TestResolvConfFallbackIsPartialStub(t *testing.T) {
	s := parseResolvConf([]byte("nameserver 127.0.0.53\nsearch example.test\n"))
	if s.Outcome != Partial || len(s.Rows) != 1 || !s.Rows[0].IsLocalStub || s.Rows[0].InterfaceKey != nil {
		t.Fatal(s)
	}
}
func TestResolvedPerLinkDomains(t *testing.T) {
	rows, e := parseResolvedDNS([]any{[]any{float64(2), float64(2), []any{float64(192), float64(0), float64(2), float64(53)}}}, []any{[]any{float64(2), "vpn.example.test", true}})
	if e != nil || len(rows) != 1 || !rows[0].Domains[0].RouteOnly || *rows[0].InterfaceKey != "linux-ifindex:2" {
		t.Fatal(rows, e)
	}
}

func TestLinuxRuleHeaderSelectorsArePartial(t *testing.T) {
	for _, test := range []struct {
		name  string
		tos   byte
		flags uint32
	}{{"tos", 8, 0}, {"invert", 0, 2}} {
		t.Run(test.name, func(t *testing.T) {
			h := make([]byte, 12)
			h[0] = syscall.AF_INET
			h[3] = test.tos
			h[4] = 254
			h[7] = 1
			binary.NativeEndian.PutUint32(h[8:], test.flags)
			r := LinuxReader{Dump: func(context.Context, uint16) ([]syscall.NetlinkMessage, error) {
				return []syscall.NetlinkMessage{{Header: syscall.NlMsghdr{Type: syscall.RTM_NEWRULE}, Data: h}}, nil
			}}
			got, err := r.Rules(context.Background(), Context{})
			if err != nil || len(got.Rows) != 1 || got.Rows[0].SelectorCoverage != "partial" || len(got.Rows[0].UnsupportedSelectorKinds) == 0 {
				t.Fatal(got, err)
			}
		})
	}
}

// #7819: the production reader probes the real sysfs root, and Interfaces/keys pass the probe through.
func TestLinuxReaderReportsInterfaceKind(t *testing.T) {
	r, ok := NewReader("epoch").(*LinuxReader)
	if !ok || r.InterfaceKind == nil {
		t.Fatal("NewReader did not wire an interface-kind probe")
	}
	// /sys/class/net/lo exists on every Linux host with ARPHRD_LOOPBACK (772).
	if got := r.InterfaceKind(net.Interface{Name: "lo"}); got != "other" {
		t.Fatalf("lo: kind %q, want other (sysfs root not read?)", got)
	}
	reader := &LinuxReader{Identities: NewInterfaceIdentities(func(string) (string, error) { return "key-1", nil }),
		InterfacesOS: func() ([]net.Interface, error) {
			return []net.Interface{{Index: 4, Name: "wg0", Flags: net.FlagUp}}, nil
		},
		InterfaceAddrs: func(net.Interface) ([]net.Addr, error) { return nil, nil },
		InterfaceKind:  func(net.Interface) string { return "tunnel" }}
	s, e := reader.Interfaces(context.Background(), Context{})
	if e != nil || len(s.Rows) != 1 || s.Rows[0].Kind != "tunnel" {
		t.Fatal(s.Rows, e)
	}
}
