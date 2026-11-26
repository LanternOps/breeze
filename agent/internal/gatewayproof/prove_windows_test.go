//go:build windows

package gatewayproof

import (
	"context"
	"net/netip"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The offsets are derived by hand from netioapi.h (MIB_IPNET_ROW2 after a
// 28-byte SOCKADDR_INET) and also asserted at compile time in prove_windows.go;
// this test re-asserts them under the native toolchain. Whether they match
// what Windows writes is shown only by a real ResolveIpNetEntry2 result, which
// the lab records.
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

// SOCKADDR_IN inside SOCKADDR_INET: family AF_INET (2, little-endian) at 0,
// port 0 at 2, the address bytes in network order at 4, zero after.
func TestSetSockaddrInet4Layout(t *testing.T) {
	var sa windows.RawSockaddrInet
	for i := range sa.Data {
		sa.Data[i] = 0xffffffff // must be cleared
	}
	setSockaddrInet4(&sa, netip.MustParseAddr("192.168.1.1"))
	b := (*[28]byte)(unsafe.Pointer(&sa))
	want := [28]byte{2, 0, 0, 0, 192, 168, 1, 1}
	if *b != want {
		t.Fatalf("SOCKADDR_INET bytes = % x\nwant                % x", b[:], want[:])
	}
	r := windowsOps{index: 7, gateway: netip.MustParseAddr("192.168.1.1")}.row()
	if r.InterfaceIndex != 7 || r.Address != sa {
		t.Fatalf("row = %+v", r)
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
