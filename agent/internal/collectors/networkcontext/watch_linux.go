//go:build linux

package networkcontext

import (
	"context"
	"errors"
	"syscall"
)

func WatchChanges(ctx context.Context, notify func()) error {
	fd, e := syscall.Socket(syscall.AF_NETLINK, syscall.SOCK_RAW|syscall.SOCK_CLOEXEC, syscall.NETLINK_ROUTE)
	if e != nil {
		return e
	}
	defer func() { _ = syscall.Close(fd) }()
	// Link/address/route notifications in the current namespace only.
	if e = syscall.Bind(fd, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK, Groups: 1 | 0x10 | 0x40 | 0x100 | 0x400}); e != nil {
		return e
	}
	if e = syscall.SetsockoptTimeval(fd, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &syscall.Timeval{Usec: 100000}); e != nil {
		return e
	}
	b := make([]byte, 64*1024)
	for {
		if e = ctx.Err(); e != nil {
			return e
		}
		_, _, e = syscall.Recvfrom(fd, b, 0)
		if errors.Is(e, syscall.EAGAIN) || errors.Is(e, syscall.EINTR) {
			continue
		}
		if e != nil {
			return e
		}
		notify()
	}
}
