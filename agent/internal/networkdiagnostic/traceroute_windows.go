//go:build windows

package networkdiagnostic

import (
	"context"
	"encoding/binary"
	"errors"
	"net/netip"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows traces through the ICMP helper API (IcmpSendEcho2Ex for IPv4,
// Icmp6SendEcho2 for IPv6) — the same unprivileged primitive tracert.exe uses.
// No raw socket and no elevation is involved. Each call sends exactly one echo
// request with the requested TTL from the bound source address and returns
// the first answer, which the API itself matches to the request.
//
// LAB-VERIFY (native Windows): the reply-buffer offsets below follow
// ipexport.h (ICMP_ECHO_REPLY: Address@0, Status@4, RoundTripTime@8;
// ICMPV6_ECHO_REPLY: packed IPV6_ADDRESS_EX with sin6_addr@6, Status@28,
// RoundTripTime@32). Unknown status codes are refused, never interpreted.

var (
	iphlpapi            = windows.NewLazySystemDLL("iphlpapi.dll")
	procIcmpCreateFile  = iphlpapi.NewProc("IcmpCreateFile")
	procIcmp6CreateFile = iphlpapi.NewProc("Icmp6CreateFile")
	procIcmpCloseHandle = iphlpapi.NewProc("IcmpCloseHandle")
	procIcmpSendEcho2Ex = iphlpapi.NewProc("IcmpSendEcho2Ex")
	procIcmp6SendEcho2  = iphlpapi.NewProc("Icmp6SendEcho2")
)

const (
	ipSuccess              = 0
	ipDestNetUnreachable   = 11002
	ipDestHostUnreachable  = 11003
	ipDestProtUnreachable  = 11004
	ipDestPortUnreachable  = 11005
	ipReqTimedOut          = 11010
	ipTTLExpiredTransit    = 11013
	ipTTLExpiredReassembly = 11014
	ipBadDestination       = 11018
	ipv6EchoReplyStatusAt  = 28
	ipv6EchoReplyRTTAt     = 32
	icmpReplyBufferBytes   = 1024
)

// ipOptionInformation mirrors IP_OPTION_INFORMATION; Go's natural alignment
// matches the C layout on both 32- and 64-bit Windows.
type ipOptionInformation struct {
	TTL         uint8
	TOS         uint8
	Flags       uint8
	OptionsSize uint8
	OptionsData uintptr
}

var (
	traceSupportOnce sync.Once
	traceSupported   bool
)

// TraceSupported reports whether the ICMP helper API is available.
func TraceSupported() bool {
	traceSupportOnce.Do(func() {
		if procIcmpCreateFile.Find() != nil || procIcmp6CreateFile.Find() != nil || procIcmpSendEcho2Ex.Find() != nil || procIcmp6SendEcho2.Find() != nil || procIcmpCloseHandle.Find() != nil {
			return
		}
		handle, _, _ := procIcmpCreateFile.Call()
		if handle == 0 || windows.Handle(handle) == windows.InvalidHandle {
			return
		}
		_, _, _ = procIcmpCloseHandle.Call(handle)
		traceSupported = true
	})
	return traceSupported
}

func (n *NativeIO) TraceTransport() (TraceTransport, error) {
	if !TraceSupported() {
		return nil, ErrTraceUnsupported
	}
	return windowsICMPTraceTransport{}, nil
}

type windowsICMPTraceTransport struct{}

func (windowsICMPTraceTransport) Probe(ctx context.Context, ttl, attempt int, destination netip.Addr, source SourceBinding) (TraceReply, error) {
	if ttl < 1 || ttl > TraceMaxHops || attempt < 1 || attempt > TraceMaxProbesPerHop || !destination.IsValid() || !source.Address.IsValid() || destination.Is4() != source.Address.Unmap().Is4() {
		return TraceReply{}, errors.New("trace_probe_invalid")
	}
	if e := ctx.Err(); e != nil {
		return TraceReply{}, e
	}
	timeout := TraceHopTimeout
	if deadline, ok := ctx.Deadline(); ok {
		if remaining := time.Until(deadline); remaining < timeout {
			timeout = remaining
		}
	}
	if timeout < time.Millisecond {
		return TraceReply{}, context.DeadlineExceeded
	}
	options := ipOptionInformation{TTL: uint8(ttl)}
	payload := make([]byte, 32)
	buffer := make([]byte, icmpReplyBufferBytes)
	started := time.Now()
	var (
		address netip.Addr
		status  uint32
		rtt     time.Duration
		err     error
	)
	if destination.Is4() {
		address, status, rtt, err = sendEcho4(destination, source, &options, payload, buffer, timeout)
	} else {
		address, status, rtt, err = sendEcho6(destination, source, &options, payload, buffer, timeout)
	}
	if err != nil {
		if ctx.Err() != nil {
			return TraceReply{}, ctx.Err()
		}
		return TraceReply{}, err
	}
	if rtt <= 0 {
		rtt = time.Since(started)
	}
	switch status {
	case ipSuccess:
		if address.WithZone("") != destination.WithZone("") {
			return TraceReply{}, errors.New("trace_reply_mismatch")
		}
		return TraceReply{Kind: TraceEchoReply, Address: address, RTT: rtt}, nil
	case ipTTLExpiredTransit, ipTTLExpiredReassembly:
		return TraceReply{Kind: TraceTimeExceeded, Address: address, RTT: rtt}, nil
	case ipDestNetUnreachable, ipDestHostUnreachable, ipDestProtUnreachable, ipDestPortUnreachable, ipBadDestination:
		return TraceReply{Kind: TraceUnreachable, Address: address, RTT: rtt}, nil
	case ipReqTimedOut:
		return TraceReply{}, context.DeadlineExceeded
	default:
		return TraceReply{}, errors.New("trace_status_unrecognized")
	}
}

// statusFromError maps a zero-reply call's last error onto an IP_STATUS code.
func statusFromError(callErr error) (uint32, error) {
	var errno syscall.Errno
	if errors.As(callErr, &errno) {
		switch uint32(errno) {
		case ipReqTimedOut:
			return ipReqTimedOut, nil
		case uint32(windows.ERROR_ACCESS_DENIED), uint32(windows.ERROR_NOT_SUPPORTED):
			return 0, ErrTraceUnsupported
		}
	}
	return 0, errors.New("trace_probe_failed")
}

func sendEcho4(destination netip.Addr, source SourceBinding, options *ipOptionInformation, payload, buffer []byte, timeout time.Duration) (netip.Addr, uint32, time.Duration, error) {
	handle, _, _ := procIcmpCreateFile.Call()
	if handle == 0 || windows.Handle(handle) == windows.InvalidHandle {
		return netip.Addr{}, 0, 0, ErrTraceUnsupported
	}
	defer func() { _, _, _ = procIcmpCloseHandle.Call(handle) }()
	src := source.Address.Unmap().As4()
	dst := destination.Unmap().As4()
	// IPAddr is the address in network byte order held in a ULONG.
	count, _, callErr := procIcmpSendEcho2Ex.Call(handle, 0, 0, 0,
		uintptr(binary.LittleEndian.Uint32(src[:])), uintptr(binary.LittleEndian.Uint32(dst[:])),
		uintptr(unsafe.Pointer(&payload[0])), uintptr(len(payload)), uintptr(unsafe.Pointer(options)),
		uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(timeout.Milliseconds()))
	if count == 0 {
		status, e := statusFromError(callErr)
		if e != nil {
			return netip.Addr{}, 0, 0, e
		}
		return netip.Addr{}, status, 0, nil
	}
	responder := netip.AddrFrom4([4]byte(buffer[0:4]))
	status := binary.LittleEndian.Uint32(buffer[4:8])
	rtt := time.Duration(binary.LittleEndian.Uint32(buffer[8:12])) * time.Millisecond
	return responder, status, rtt, nil
}

func sendEcho6(destination netip.Addr, source SourceBinding, options *ipOptionInformation, payload, buffer []byte, timeout time.Duration) (netip.Addr, uint32, time.Duration, error) {
	handle, _, _ := procIcmp6CreateFile.Call()
	if handle == 0 || windows.Handle(handle) == windows.InvalidHandle {
		return netip.Addr{}, 0, 0, ErrTraceUnsupported
	}
	defer func() { _, _, _ = procIcmpCloseHandle.Call(handle) }()
	src := windows.RawSockaddrInet6{Family: windows.AF_INET6, Addr: source.Address.As16()}
	dst := windows.RawSockaddrInet6{Family: windows.AF_INET6, Addr: destination.As16()}
	if source.Address.IsLinkLocalUnicast() {
		src.Scope_id = source.OSIndex
	}
	if destination.IsLinkLocalUnicast() {
		dst.Scope_id = source.OSIndex
	}
	count, _, callErr := procIcmp6SendEcho2.Call(handle, 0, 0, 0,
		uintptr(unsafe.Pointer(&src)), uintptr(unsafe.Pointer(&dst)),
		uintptr(unsafe.Pointer(&payload[0])), uintptr(len(payload)), uintptr(unsafe.Pointer(options)),
		uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(timeout.Milliseconds()))
	if count == 0 {
		status, e := statusFromError(callErr)
		if e != nil {
			return netip.Addr{}, 0, 0, e
		}
		return netip.Addr{}, status, 0, nil
	}
	responder := netip.AddrFrom16([16]byte(buffer[6:22]))
	status := binary.LittleEndian.Uint32(buffer[ipv6EchoReplyStatusAt : ipv6EchoReplyStatusAt+4])
	rtt := time.Duration(binary.LittleEndian.Uint32(buffer[ipv6EchoReplyRTTAt:ipv6EchoReplyRTTAt+4])) * time.Millisecond
	return responder, status, rtt, nil
}
