//go:build linux

package networkdiagnostic

import (
	"net"
	"syscall"
)

func bindInterface(index uint32, _ bool) func(string, string, syscall.RawConn) error {
	return func(_, _ string, raw syscall.RawConn) error {
		iface, e := net.InterfaceByIndex(int(index))
		if e != nil {
			return e
		}
		var bindErr error
		e = raw.Control(func(fd uintptr) {
			bindErr = syscall.SetsockoptString(int(fd), syscall.SOL_SOCKET, syscall.SO_BINDTODEVICE, iface.Name)
		})
		if e != nil {
			return e
		}
		return bindErr
	}
}
