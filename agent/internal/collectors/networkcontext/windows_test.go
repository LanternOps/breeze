//go:build windows

package networkcontext

import (
	"context"
	"golang.org/x/sys/windows"
	"net/netip"
	"testing"
	"unsafe"
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

// Windows 10 1507 has no GetIfEntry2Ex export (#9233). The lookup must fall
// back to GetIfEntry2 instead of panicking on the missing procedure.
func TestGetIfEntry2FallsBackWhenExIsMissing(t *testing.T) {
	adapters, err := readWindowsAdapters(context.Background())
	if err != nil || len(adapters) == 0 {
		t.Skip("no adapters:", err)
	}
	want := adapters[0]
	missing := ipHelper.NewProc("GetIfEntry2ExMissingOn1507")
	for name, ex := range map[string]*windows.LazyProc{"ex": ifEntry2Ex, "fallback": missing} {
		if name == "ex" && ex.Find() != nil {
			continue
		}
		row := windows.MibIfRow2{InterfaceLuid: want.LUID}
		if err := getIfEntry2(ex, ifEntry2, &row); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if row.InterfaceLuid != want.LUID || row.InterfaceIndex == 0 {
			t.Fatalf("%s: row for LUID %d not filled: %+v", name, want.LUID, row.InterfaceIndex)
		}
	}
}

// GetBestRoute2 rejects a scope id on a destination whose scope is global
// (ERROR_INVALID_PARAMETER, observed on Windows 11 build 26200), so an
// interface-pinned lookup for any routable IPv6 address failed. Only link-local
// addresses carry the interface as their zone.
func TestWindowsSockaddrScopesOnlyLinkLocalIPv6(t *testing.T) {
	for raw, want := range map[string]uint32{"fe80::1": 31, "2001:db8::1": 0, "fd7a:115c:a1e0::1": 0} {
		v := (*windows.RawSockaddrInet6)(unsafe.Pointer(&[]windows.RawSockaddrInet{winSockaddr(netip.MustParseAddr(raw), 31)}[0]))
		if v.Scope_id != want || v.Addr != netip.MustParseAddr(raw).As16() {
			t.Fatalf("%s: scope %d, want %d", raw, v.Scope_id, want)
		}
	}
}
