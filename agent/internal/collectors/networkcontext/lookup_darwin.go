//go:build darwin

package networkcontext

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"syscall"
	"time"

	"golang.org/x/net/route"
)

// LookupRoute asks the routing socket for this destination; it sends no packet
// to the destination. Source-policy requests that Darwin cannot enforce fail.
func (r *DarwinReader) LookupRoute(ctx context.Context, request RouteLookupRequest) (RouteSelection, error) {
	keys, err := r.keys(ctx)
	if err != nil {
		return RouteSelection{}, err
	}
	return lookupDarwinRoute(ctx, request, keys)
}
func lookupDarwinRoute(ctx context.Context, request RouteLookupRequest, keys map[int]string) (RouteSelection, error) {
	if !request.Destination.IsValid() || request.ContextKey != "darwin:default" {
		return RouteSelection{}, ErrUnsupported
	}
	fd, e := syscall.Socket(syscall.AF_ROUTE, syscall.SOCK_RAW, syscall.AF_UNSPEC)
	if e != nil {
		return RouteSelection{}, e
	}
	defer func() { _ = syscall.Close(fd) }()
	if e = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &syscall.Timeval{Usec: 100000}); e != nil {
		return RouteSelection{}, e
	}
	destination := request.Destination
	var native route.Addr
	if destination.Is4() {
		native = &route.Inet4Addr{IP: destination.As4()}
	} else {
		a := &route.Inet6Addr{IP: destination.As16()}
		if destination.Zone() != "" {
			iface, e := net.InterfaceByName(destination.Zone())
			if e != nil {
				return RouteSelection{}, ErrUnsupported
			}
			a.ZoneID = iface.Index
		}
		native = a
	}
	const sequence = 1
	message := route.RouteMessage{Version: syscall.RTM_VERSION, Type: syscall.RTM_GET, Flags: syscall.RTF_UP | syscall.RTF_HOST, ID: uintptr(os.Getpid()), Seq: sequence, Addrs: []route.Addr{syscall.RTAX_DST: native, syscall.RTAX_IFP: &route.LinkAddr{}}}
	payload, e := message.Marshal()
	if e != nil {
		return RouteSelection{}, e
	}
	if _, e = syscall.Write(fd, payload); e != nil {
		return RouteSelection{}, e
	}
	deadline := time.Now().Add(2 * time.Second)
	buffer := make([]byte, 64*1024)
	for time.Now().Before(deadline) {
		if e = ctx.Err(); e != nil {
			return RouteSelection{}, e
		}
		n, _, e := syscall.Recvfrom(fd, buffer, 0)
		if errors.Is(e, syscall.EAGAIN) || errors.Is(e, syscall.EINTR) {
			continue
		}
		if e != nil {
			return RouteSelection{}, e
		}
		messages, e := route.ParseRIB(route.RIBTypeRoute, buffer[:n])
		if e != nil {
			return RouteSelection{}, e
		}
		for _, value := range messages {
			m, ok := value.(*route.RouteMessage)
			if !ok || m.ID != uintptr(os.Getpid()) || m.Seq != sequence || m.Type != syscall.RTM_GET {
				continue
			}
			if m.Err != nil {
				return RouteSelection{}, m.Err
			}
			key, exists := keys[m.Index]
			if !exists {
				return RouteSelection{}, ErrUnsupported
			}
			if request.InterfaceKey != "" && request.InterfaceKey != key {
				return RouteSelection{}, ErrUnsupported
			}
			out := RouteSelection{ContextKey: request.ContextKey, InterfaceKey: key, OSIndex: uint32(m.Index), Attribution: "observed"}
			if ip, _, ok := nativeAddr(addrAt(m.Addrs, syscall.RTAX_GATEWAY)); ok && !ip.IsUnspecified() {
				out.NextHop = ptr(ip.String())
				if ip.Is6() && ip.IsLinkLocalUnicast() {
					out.Zone = ptr(key)
				}
			}
			if ip, _, ok := nativeAddr(addrAt(m.Addrs, syscall.RTAX_IFA)); ok {
				out.SourceAddress = ip.String()
			}
			if request.Source.IsValid() {
				if out.SourceAddress == "" || request.Source.WithZone("") != netip.MustParseAddr(out.SourceAddress) {
					return RouteSelection{}, ErrUnsupported
				}
			}
			if out.SourceAddress == "" {
				out.Attribution = "requested_unverified"
			}
			return out, nil
		}
	}
	return RouteSelection{}, context.DeadlineExceeded
}
