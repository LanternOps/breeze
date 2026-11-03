package isolation

import (
	"net/netip"
	"reflect"
	"testing"
)

func TestTCPRowNativeNetworkByteOrder(t *testing.T) {
	row := tcpRow{State: 5, Local: netip.MustParseAddrPort("192.0.2.10:49152"), Remote: netip.MustParseAddrPort("203.0.113.15:443"), PID: 77}
	native := tcpDeleteRow(row)
	if native.State != 12 || native.LocalAddr != 0x0a0200c0 || native.LocalPort != 0x00c0 || native.RemoteAddr != 0x0f7100cb || native.RemotePort != 0xbb01 {
		t.Fatalf("wrong MIB_TCPROW network ordering: %#v", native)
	}
	got := tcpRowFromNative(mibTCPRowOwnerPID{mibTCPRow: native, OwnerPID: row.PID})
	if got.Local != row.Local || got.Remote != row.Remote || got.PID != row.PID {
		t.Fatalf("native round trip = %+v, want endpoints of %+v", got, row)
	}
}

func TestTCPTeardownSelectsOnlyUnpermittedIPv4Flows(t *testing.T) {
	agent := `C:\Program Files\Breeze\breeze-agent.exe`
	rs := ResolvedSpec{Entries: []ResolvedEntry{
		{AllowEntry: AllowEntry{Proto: ProtoUDPTCP, Scope: ScopeBreeze, Ports: []uint16{443, 8443}}, Addrs: []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}},
		{AllowEntry: AllowEntry{Proto: ProtoTCP, Scope: ScopeAny, Ports: []uint16{443}}, Addrs: []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")}},
		{AllowEntry: AllowEntry{Proto: ProtoUDP, Scope: ScopeAny, Ports: []uint16{53}}, Addrs: []netip.Prefix{netip.MustParsePrefix("203.0.113.0/24")}},
	}}
	base := Baseline{Resolvers: []netip.Addr{netip.MustParseAddr("192.0.2.53")}}
	cases := []struct {
		name, remote, app string
		wantDelete        bool
	}{
		{"agent control plane", "192.0.2.10:443", agent, false},
		{"second port and case-insensitive path", "192.0.2.10:8443", `c:/PROGRAM FILES/Breeze/BREEZE-AGENT.EXE`, false},
		{"child at shared destination", "192.0.2.10:443", `C:\Windows\cmd.exe`, true},
		{"unknown executable", "192.0.2.10:443", "", true},
		{"agent wrong port", "192.0.2.10:80", agent, true},
		{"agent wrong address", "203.0.113.10:443", agent, true},
		{"any-scope permit", "198.51.100.20:443", `C:\Windows\cmd.exe`, false},
		{"TCP does not match UDP permit", "203.0.113.53:53", agent, true},
		{"configured resolver", "192.0.2.53:53", `C:\Windows\svchost.exe`, false},
		{"resolver wrong port", "192.0.2.53:443", `C:\Windows\svchost.exe`, true},
		{"other resolver", "192.0.2.54:53", `C:\Windows\svchost.exe`, true},
		{"IPv6 left to ALE reauthorization", "[2001:db8::10]:443", agent, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			row := tcpRow{State: 5, Local: netip.MustParseAddrPort("203.0.113.1:49152"), Remote: netip.MustParseAddrPort(tc.remote), AppPath: tc.app}
			got := selectTCPRowsToDelete([]tcpRow{row}, rs, []string{agent}, base)
			if (len(got) == 1) != tc.wantDelete {
				t.Fatalf("delete = %v, want %v", got, tc.wantDelete)
			}
		})
	}
}

func TestTCPTeardownPreservesLoopbackAndInactiveRows(t *testing.T) {
	row := tcpRow{State: 5, Local: netip.MustParseAddrPort("192.0.2.1:49152"), Remote: netip.MustParseAddrPort("203.0.113.10:443")}
	for state := uint32(0); state <= 13; state++ {
		row.State = state
		got := selectTCPRowsToDelete([]tcpRow{row}, ResolvedSpec{}, nil, Baseline{})
		if (len(got) == 1) != (state >= 3 && state <= 10) {
			t.Errorf("state %d selected = %v", state, got)
		}
	}
	row.State = 5
	for _, tc := range []struct {
		name string
		edit func(*tcpRow)
	}{
		{"loopback remote", func(r *tcpRow) { r.Remote = netip.AddrPortFrom(netip.AddrFrom4([4]byte{127, 0, 0, 1}), 443) }},
		{"loopback local", func(r *tcpRow) { r.Local = netip.AddrPortFrom(netip.AddrFrom4([4]byte{127, 0, 0, 1}), 49152) }},
		{"same host address", func(r *tcpRow) { r.Remote = netip.AddrPortFrom(r.Local.Addr(), 443) }},
		{"other local interface", func(r *tcpRow) { r.Loopback = true }},
		{"invalid endpoint", func(r *tcpRow) { r.Remote = netip.AddrPort{} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := row
			tc.edit(&candidate)
			if got := selectTCPRowsToDelete([]tcpRow{candidate}, ResolvedSpec{}, nil, Baseline{}); len(got) != 0 {
				t.Fatalf("selected protected/non-connection row: %v", got)
			}
		})
	}
}

func TestTCPTeardownDoesNotMutateAndHandlesEmptyInput(t *testing.T) {
	if got := selectTCPRowsToDelete(nil, ResolvedSpec{}, nil, Baseline{}); len(got) != 0 {
		t.Fatal(got)
	}
	rows := []tcpRow{{State: 5, Local: netip.MustParseAddrPort("192.0.2.1:49152"), Remote: netip.MustParseAddrPort("203.0.113.10:443")}}
	original := append([]tcpRow(nil), rows...)
	rs := ResolvedSpec{Entries: []ResolvedEntry{{AllowEntry: AllowEntry{Proto: ProtoTCP, Scope: "invalid", Ports: []uint16{443}}, Addrs: []netip.Prefix{netip.MustParsePrefix("203.0.113.0/24")}}}}
	got := selectTCPRowsToDelete(rows, rs, nil, Baseline{})
	if len(got) != 1 || !reflect.DeepEqual(rows, original) {
		t.Fatalf("unknown scope permitted or input mutated: got=%v input=%v", got, rows)
	}
	got[0].State = 12
	if !reflect.DeepEqual(rows, original) {
		t.Fatal("selection aliases input")
	}
}
