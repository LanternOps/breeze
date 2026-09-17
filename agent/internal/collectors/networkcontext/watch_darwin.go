//go:build darwin

package networkcontext

import (
	"context"
	"errors"
	"golang.org/x/net/route"
	"syscall"
)

func WatchChanges(ctx context.Context, notify func()) error {
	fd, e := syscall.Socket(syscall.AF_ROUTE, syscall.SOCK_RAW, syscall.AF_UNSPEC)
	if e != nil {
		return e
	}
	defer func() { _ = syscall.Close(fd) }()
	if e = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &syscall.Timeval{Usec: 100000}); e != nil {
		return e
	}
	b := make([]byte, 64*1024)
	for {
		if e = ctx.Err(); e != nil {
			return e
		}
		n, _, e := syscall.Recvfrom(fd, b, 0)
		if errors.Is(e, syscall.EAGAIN) || errors.Is(e, syscall.EINTR) {
			continue
		}
		if e != nil {
			return e
		}
		messages, e := route.ParseRIB(route.RIBTypeRoute, b[:n])
		if e != nil {
			return e
		}
		for _, m := range messages {
			switch v := m.(type) {
			case *route.InterfaceMessage, *route.InterfaceAddrMessage:
				notify()
			case *route.RouteMessage:
				if v.Type == syscall.RTM_ADD || v.Type == syscall.RTM_DELETE || v.Type == syscall.RTM_CHANGE {
					notify()
				}
			}
		}
	}
}
