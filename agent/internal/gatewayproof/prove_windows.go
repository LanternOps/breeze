//go:build windows

package gatewayproof

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"net/netip"
	"os"
	"runtime"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

// x/sys v0.50.0 wraps none of these; each is checked with Find() before Call()
// so an export missing on an older build is an error, not a panic.
var (
	iphlpapi               = windows.NewLazySystemDLL("iphlpapi.dll")
	procResolveIpNetEntry2 = iphlpapi.NewProc("ResolveIpNetEntry2")
	procGetIpNetEntry2     = iphlpapi.NewProc("GetIpNetEntry2")
	procDeleteIpNetEntry2  = iphlpapi.NewProc("DeleteIpNetEntry2")
	procFlushIpNetTable2   = iphlpapi.NewProc("FlushIpNetTable2")
	procSendARP            = iphlpapi.NewProc("SendARP")
)

// procCalls counts iphlpapi calls; tests read it to prove a rejected request
// reached none.
var procCalls atomic.Int64

// mibIpnetRow2 mirrors MIB_IPNET_ROW2 (netioapi.h). The same layout exists
// unexported as windowsNeighbor in internal/collectors/networkcontext.
type mibIpnetRow2 struct {
	Address               windows.RawSockaddrInet // SOCKADDR_INET, 28 bytes
	InterfaceIndex        uint32
	InterfaceLuid         uint64
	PhysicalAddress       [32]byte // IF_MAX_PHYS_ADDRESS_LENGTH
	PhysicalAddressLength uint32
	State                 uint32 // NL_NEIGHBOR_STATE
	Flags                 uint8  // IsRouter:1, IsUnreachable:1
	_                     [3]byte
	ReachabilityTime      uint32 // LastReachable / LastUnreachable, ms
}

// Compile-time layout checks: the cross-compile fails if any offset moves.
// Each pair of zero-length arrays only builds when the two values are equal.
var layoutRow mibIpnetRow2

var (
	_ [unsafe.Sizeof(layoutRow) - 88]struct{}
	_ [88 - unsafe.Sizeof(layoutRow)]struct{}
	_ [unsafe.Offsetof(layoutRow.InterfaceIndex) - 28]struct{}
	_ [28 - unsafe.Offsetof(layoutRow.InterfaceIndex)]struct{}
	_ [unsafe.Offsetof(layoutRow.InterfaceLuid) - 32]struct{}
	_ [32 - unsafe.Offsetof(layoutRow.InterfaceLuid)]struct{}
	_ [unsafe.Offsetof(layoutRow.PhysicalAddress) - 40]struct{}
	_ [40 - unsafe.Offsetof(layoutRow.PhysicalAddress)]struct{}
	_ [unsafe.Offsetof(layoutRow.PhysicalAddressLength) - 72]struct{}
	_ [72 - unsafe.Offsetof(layoutRow.PhysicalAddressLength)]struct{}
	_ [unsafe.Offsetof(layoutRow.State) - 76]struct{}
	_ [76 - unsafe.Offsetof(layoutRow.State)]struct{}
	_ [unsafe.Offsetof(layoutRow.Flags) - 80]struct{}
	_ [80 - unsafe.Offsetof(layoutRow.Flags)]struct{}
	_ [unsafe.Offsetof(layoutRow.ReachabilityTime) - 84]struct{}
	_ [84 - unsafe.Offsetof(layoutRow.ReachabilityTime)]struct{}
)

// prove runs the Windows candidate selected for this spike.
func prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
	m, err := spikeMethod()
	if err != nil {
		return nil, err
	}
	return proveWith(ctx, iface, gateway, m)
}

// spikeMethod reads GATEWAYPROOF_WINDOWS_METHOD (W1 when unset). It exists for
// the lab runs only; the decision task removes it with the losing methods.
func spikeMethod() (windowsMethod, error) {
	return parseWindowsMethod(os.Getenv("GATEWAYPROOF_WINDOWS_METHOD"))
}

func proveWith(ctx context.Context, iface Interface, gateway netip.Addr, m windowsMethod) (net.HardwareAddr, error) {
	return runMethod(ctx, windowsOps{index: iface.Index, gateway: gateway, source: iface.Source}, m)
}

// windowsOps implements neighborOps with iphlpapi. Every method allocates its
// own row and buffers, so a blocking call that outlives the caller's deadline
// writes only into memory nothing else uses.
type windowsOps struct {
	index           uint32
	gateway, source netip.Addr
}

func (o windowsOps) row() *mibIpnetRow2 {
	r := &mibIpnetRow2{InterfaceIndex: o.index}
	setSockaddrInet4(&r.Address, o.gateway)
	return r
}

func (o windowsOps) getEntry() (neighborState, bool, error) {
	r := o.row()
	code, err := callProc(procGetIpNetEntry2, uintptr(unsafe.Pointer(r)))
	runtime.KeepAlive(r)
	switch {
	case err != nil:
		return 0, false, err
	case code == 0:
		return neighborState(r.State), true, nil
	case uint32(code) == errNotFound:
		return 0, false, nil
	}
	return 0, false, &iphlpError{call: "GetIpNetEntry2", code: uint32(code)}
}

func (o windowsOps) deleteEntry() error {
	r := o.row()
	code, err := callProc(procDeleteIpNetEntry2, uintptr(unsafe.Pointer(r)))
	runtime.KeepAlive(r)
	if err != nil {
		return err
	}
	if code != 0 && uint32(code) != errNotFound {
		return &iphlpError{call: "DeleteIpNetEntry2", code: uint32(code)}
	}
	return nil
}

func (o windowsOps) flushInterface() error {
	code, err := callProc(procFlushIpNetTable2, uintptr(windows.AF_INET), uintptr(o.index))
	if err != nil {
		return err
	}
	if code != 0 {
		return &iphlpError{call: "FlushIpNetTable2", code: uint32(code)}
	}
	return nil
}

func (o windowsOps) resolve() (neighborResult, error) {
	r := o.row()
	var source windows.RawSockaddrInet
	setSockaddrInet4(&source, o.source)
	code, err := callProc(procResolveIpNetEntry2, uintptr(unsafe.Pointer(r)), uintptr(unsafe.Pointer(&source)))
	runtime.KeepAlive(r)
	runtime.KeepAlive(&source)
	if err != nil {
		return neighborResult{}, err
	}
	if code != 0 {
		return neighborResult{}, &iphlpError{call: "resolve", code: uint32(code)}
	}
	n := min(int(r.PhysicalAddressLength), len(r.PhysicalAddress))
	return neighborResult{
		mac:           append([]byte(nil), r.PhysicalAddress[:n]...),
		state:         neighborState(r.State),
		hasState:      true,
		lastReachable: r.ReachabilityTime,
	}, nil
}

func (o windowsOps) sendARP() (neighborResult, error) {
	var buf [8]byte // ULONG[2]; SendARP needs at least 6 bytes
	size := uint32(len(buf))
	code, err := callProc(procSendARP,
		uintptr(ipAddrValue(o.gateway)), uintptr(ipAddrValue(o.source)),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)))
	runtime.KeepAlive(&buf)
	runtime.KeepAlive(&size)
	if err != nil {
		return neighborResult{}, err
	}
	if code != 0 {
		return neighborResult{}, &iphlpError{call: "sendarp", code: uint32(code)}
	}
	n := min(int(size), len(buf))
	return neighborResult{mac: append([]byte(nil), buf[:n]...)}, nil
}

// callProc checks that the export exists, then calls it, returning its status
// code. uintptrescapes keeps every pointer passed as a uintptr alive and on
// the heap for the duration of the call, as LazyProc.Call does.
//
//go:uintptrescapes
func callProc(p *windows.LazyProc, args ...uintptr) (uintptr, error) {
	procCalls.Add(1)
	if err := p.Find(); err != nil {
		return 0, fmt.Errorf("iphlpapi %s unavailable: %w", p.Name, err)
	}
	code, _, _ := p.Call(args...)
	return code, nil
}

func setSockaddrInet4(sa *windows.RawSockaddrInet, a netip.Addr) {
	*sa = windows.RawSockaddrInet{}
	s4 := (*windows.RawSockaddrInet4)(unsafe.Pointer(sa))
	s4.Family = windows.AF_INET
	s4.Addr = a.As4()
}

// ipAddrValue is the IPAddr (in_addr as a ULONG) SendARP takes: the address
// bytes in network order in memory.
func ipAddrValue(a netip.Addr) uint32 {
	b := a.As4()
	return binary.NativeEndian.Uint32(b[:])
}
