//go:build windows

package gatewayproof

import (
	"context"
	"net/netip"
	"testing"
	"unsafe"
)

// The offsets are computed from netioapi.h (MIB_IPNET_ROW2 after a 28-byte
// SOCKADDR_INET); this test, run natively, is what confirms them. The same
// values are also asserted at compile time in prove_windows.go.
func TestMibIpnetRow2Layout(t *testing.T) {
	var r mibIpnetRow2
	if got := unsafe.Sizeof(r); got != 88 {
		t.Errorf("Sizeof = %d, want 88", got)
	}
	for name, tc := range map[string]struct{ got, want uintptr }{
		"InterfaceIndex":        {unsafe.Offsetof(r.InterfaceIndex), 28},
		"InterfaceLuid":         {unsafe.Offsetof(r.InterfaceLuid), 32},
		"PhysicalAddress":       {unsafe.Offsetof(r.PhysicalAddress), 40},
		"PhysicalAddressLength": {unsafe.Offsetof(r.PhysicalAddressLength), 72},
		"State":                 {unsafe.Offsetof(r.State), 76},
		"Flags":                 {unsafe.Offsetof(r.Flags), 80},
		"ReachabilityTime":      {unsafe.Offsetof(r.ReachabilityTime), 84},
	} {
		if tc.got != tc.want {
			t.Errorf("Offsetof(%s) = %d, want %d", name, tc.got, tc.want)
		}
	}
}

func TestIphlpapiProcsResolve(t *testing.T) {
	for _, p := range []interface {
		Find() error
	}{procResolveIpNetEntry2, procGetIpNetEntry2, procDeleteIpNetEntry2, procFlushIpNetTable2, procSendARP} {
		if err := p.Find(); err != nil {
			t.Errorf("Find: %v", err)
		}
	}
}

func TestProveWindows_RejectsBeforeCalling(t *testing.T) {
	before := procCalls.Load()
	_, err := Prove(context.Background(), Interface{Name: "Ethernet", Index: 0, Source: netip.MustParseAddr("192.168.1.57")},
		netip.MustParseAddr("192.168.1.1"))
	if err == nil {
		t.Fatal("Index 0 accepted")
	}
	if n := procCalls.Load() - before; n != 0 {
		t.Fatalf("%d iphlpapi calls before the request was rejected", n)
	}
}

func TestProveWindows_BadMethodIsAnError(t *testing.T) {
	t.Setenv("GATEWAYPROOF_WINDOWS_METHOD", "W9")
	before := procCalls.Load()
	_, err := Prove(context.Background(), Interface{Name: "Ethernet", Index: 1, Source: netip.MustParseAddr("192.168.1.57")},
		netip.MustParseAddr("192.168.1.1"))
	if err == nil {
		t.Fatal("an unknown method was accepted")
	}
	if n := procCalls.Load() - before; n != 0 {
		t.Fatalf("%d iphlpapi calls for an unknown method", n)
	}
}

func TestIPAddrValue(t *testing.T) {
	// IPAddr holds the address in network byte order in memory.
	v := ipAddrValue(netip.MustParseAddr("192.168.1.57"))
	b := (*[4]byte)(unsafe.Pointer(&v))
	if *b != [4]byte{192, 168, 1, 57} {
		t.Fatalf("IPAddr bytes = %v", *b)
	}
}
