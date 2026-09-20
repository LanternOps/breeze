//go:build linux

package networkcontext

import (
	"context"
	"encoding/binary"
	"errors"
	"syscall"
	"time"
)

func appendLinuxAttr(payload []byte, kind uint16, data []byte) []byte {
	n := len(data) + 4
	b := make([]byte, (n+3)&^3)
	binary.NativeEndian.PutUint16(b, uint16(n))
	binary.NativeEndian.PutUint16(b[2:], kind)
	copy(b[4:], data)
	return append(payload, b...)
}
func (r *LinuxReader) LookupRoute(parent context.Context, request RouteLookupRequest) (RouteSelection, error) {
	if !request.Destination.IsValid() {
		return RouteSelection{}, ErrMalformed
	}
	namespace, e := r.Namespace()
	if e != nil {
		return RouteSelection{}, e
	}
	if request.ContextKey != "linux:"+namespace {
		return RouteSelection{}, ErrUnsupported
	}
	keys, e := r.keys(parent)
	if e != nil {
		return RouteSelection{}, e
	}
	payload := make([]byte, 12)
	payload[0] = syscall.AF_INET
	if request.Destination.Is6() {
		payload[0] = syscall.AF_INET6
	}
	payload[1] = byte(request.Destination.BitLen())
	payload = appendLinuxAttr(payload, 1, request.Destination.AsSlice())
	if request.Source.IsValid() {
		if request.Source.BitLen() != request.Destination.BitLen() {
			return RouteSelection{}, ErrMalformed
		}
		payload[2] = byte(request.Source.BitLen())
		payload = appendLinuxAttr(payload, 2, request.Source.AsSlice())
	}
	if request.InterfaceKey != "" {
		index := 0
		for i, key := range keys {
			if key == request.InterfaceKey {
				index = i
				break
			}
		}
		if index == 0 {
			return RouteSelection{}, ErrUnsupported
		}
		b := make([]byte, 4)
		binary.NativeEndian.PutUint32(b, uint32(index))
		payload = appendLinuxAttr(payload, 4, b)
	}
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	fd, e := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, syscall.NETLINK_ROUTE)
	if e != nil {
		return RouteSelection{}, e
	}
	defer func() { _ = syscall.Close(fd) }()
	if e = syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); e != nil {
		return RouteSelection{}, e
	}
	if e = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &syscall.Timeval{Usec: 100000}); e != nil {
		return RouteSelection{}, e
	}
	raw := make([]byte, 16)
	binary.NativeEndian.PutUint32(raw, uint32(16+len(payload)))
	binary.NativeEndian.PutUint16(raw[4:], syscall.RTM_GETROUTE)
	binary.NativeEndian.PutUint16(raw[6:], syscall.NLM_F_REQUEST)
	binary.NativeEndian.PutUint32(raw[8:], 1)
	raw = append(raw, payload...)
	if e = syscall.Sendto(fd, raw, 0, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}); e != nil {
		return RouteSelection{}, e
	}
	b := make([]byte, 64*1024)
	for {
		if e = ctx.Err(); e != nil {
			return RouteSelection{}, e
		}
		n, from, e := syscall.Recvfrom(fd, b, syscall.MSG_TRUNC)
		if errors.Is(e, syscall.EAGAIN) || errors.Is(e, syscall.EINTR) {
			continue
		}
		if e != nil {
			return RouteSelection{}, e
		}
		if n > len(b) {
			return RouteSelection{}, ErrLimit
		}
		sender, ok := from.(*syscall.SockaddrNetlink)
		if !ok || sender.Pid != 0 {
			return RouteSelection{}, ErrMalformed
		}
		messages, e := syscall.ParseNetlinkMessage(b[:n])
		if e != nil {
			return RouteSelection{}, e
		}
		for _, m := range messages {
			if m.Header.Seq != 1 {
				continue
			}
			if m.Header.Type == syscall.NLMSG_ERROR {
				if len(m.Data) < 4 {
					return RouteSelection{}, ErrMalformed
				}
				code := int32(binary.NativeEndian.Uint32(m.Data))
				if code != 0 {
					return RouteSelection{}, syscall.Errno(-code)
				}
				continue
			}
			if m.Header.Type != syscall.RTM_NEWROUTE {
				continue
			}
			if len(m.Data) < 12 {
				return RouteSelection{}, ErrMalformed
			}
			attrs, e := linuxAttrs(m.Data[12:])
			if e != nil {
				return RouteSelection{}, e
			}
			index, e := attrU32(attrs, 4, 0)
			if e != nil {
				return RouteSelection{}, e
			}
			key, ok := keys[int(index)]
			if !ok {
				return RouteSelection{}, ErrUnsupported
			}
			if request.InterfaceKey != "" && request.InterfaceKey != key {
				return RouteSelection{}, ErrUnsupported
			}
			hop, e := linuxHop(attrs, m.Data[0], keys, int(index))
			if e != nil {
				return RouteSelection{}, e
			}
			out := RouteSelection{ContextKey: request.ContextKey, InterfaceKey: key, OSIndex: index, NextHop: hop.Address, Zone: hop.Zone, Attribution: "observed"}
			if source, ok := attrs[7]; ok {
				ip, e := linuxIP(source, m.Data[0])
				if e != nil {
					return RouteSelection{}, e
				}
				out.SourceAddress = ip.String()
			} else if request.Source.IsValid() {
				out.SourceAddress = request.Source.String()
				out.Attribution = "requested_unverified"
			} else {
				out.Attribution = "unknown"
			}
			return out, nil
		}
	}
}
