//go:build windows

package networkcontext

import (
	"golang.org/x/sys/windows"
	"net/netip"
	"testing"
)

func TestWindowsIdentitySurvivesIndexChanges(t *testing.T) {
	a := InterfaceIdentity(Adapter{GUID: "{ADAPTER-A}", Index: 7})
	b := InterfaceIdentity(Adapter{GUID: "{adapter-a}", Index: 12})
	c := InterfaceIdentity(Adapter{GUID: "{adapter-b}", Index: 7})
	if a != b || a == c {
		t.Fatal(a, b, c)
	}
}
func TestWindowsMultipleDefaultRoutesRetained(t *testing.T) {
	rows := []windows.MibIpForwardRow2{}
	for _, index := range []uint32{2, 3} {
		rows = append(rows, windows.MibIpForwardRow2{InterfaceIndex: index, DestinationPrefix: windows.IpAddressPrefix{Prefix: winSockaddr(netip.IPv6Unspecified(), 0)}, NextHop: winSockaddr(netip.MustParseAddr("fe80::1"), index), Metric: 10})
	}
	got, e := windowsRouteRows(rows, map[uint32]string{2: "a", 3: "b"})
	if e != nil || len(got) != 2 || *got[0].NextHops[0].Zone == *got[1].NextHops[0].Zone {
		t.Fatal(got, e)
	}
}
