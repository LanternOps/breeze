//go:build darwin

package networkcontext

import (
	"context"
	"errors"
	"golang.org/x/net/route"
	"net"
	"syscall"
	"testing"
)

func TestDarwinScopedRoutes(t *testing.T) {
	messages := []route.Message{}
	for _, index := range []int{2, 3} {
		messages = append(messages, &route.RouteMessage{Index: index, Flags: syscall.RTF_UP | syscall.RTF_GATEWAY | syscall.RTF_IFSCOPE, Addrs: []route.Addr{syscall.RTAX_DST: &route.Inet6Addr{}, syscall.RTAX_GATEWAY: &route.Inet6Addr{IP: [16]byte{0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}, ZoneID: index}, syscall.RTAX_NETMASK: &route.Inet6Addr{}}})
	}
	rows, e := parseDarwinRoutes(messages, map[int]string{2: "if2", 3: "if3"})
	if e != nil || len(rows) != 2 {
		t.Fatal(rows, e)
	}
	if *rows[0].NextHops[0].Zone == *rows[1].NextHops[0].Zone {
		t.Fatal("collapsed zones")
	}
}
func TestDarwinDumpFailureIsNotEmptySuccess(t *testing.T) {
	reader := &DarwinReader{Identities: NewInterfaceIdentities(func(s string) (string, error) { return s, nil }), InterfacesOS: func() ([]net.Interface, error) { return nil, nil }, InterfaceAddrs: func(net.Interface) ([]net.Addr, error) { t.Fatal("unexpected address call"); return nil, nil }, FetchRIB: func(int, route.RIBType, int) ([]byte, error) { return nil, syscall.EACCES }}
	s, e := reader.Routes(context.Background(), Context{})
	s = finishSection(s, "routes", "darwin:default", 2048, e)
	if !errors.Is(e, syscall.EACCES) || s.Outcome != Failed {
		t.Fatal(s, e)
	}
}
func TestScopedDNSIncompleteNeverEmptyComplete(t *testing.T) {
	got := ParseScopedDNS([]byte("resolver #1\n  nameserver[0] : 127.0.0.1\n  if_index :"))
	if got.Outcome != Partial || len(got.Rows) != 1 || !got.Rows[0].IsLocalStub {
		t.Fatal(got)
	}
}
func TestScopedDNSSplitDomainsAndZones(t *testing.T) {
	got := ParseScopedDNS([]byte("resolver #1\n nameserver[0] : fe80::1\n if_index : 7 (utun0)\n domain : vpn.example.test\nresolver #2\n nameserver[0] : 192.0.2.53\n search domain[0] : example.test\n"))
	if got.Outcome != Complete || len(got.Rows) != 2 || got.Rows[0].Zone == nil || !got.Rows[0].Domains[0].RouteOnly || got.Rows[1].Domains[0].RouteOnly {
		t.Fatal(got)
	}
}
