//go:build darwin

package networkdiagnostic

import "syscall"

func bindInterface(index uint32, ipv6 bool) func(string, string, syscall.RawConn) error {
	return func(_, _ string, raw syscall.RawConn) error {
		level, option := syscall.IPPROTO_IP, syscall.IP_BOUND_IF
		if ipv6 {
			level, option = syscall.IPPROTO_IPV6, syscall.IPV6_BOUND_IF
		}
		var bindErr error
		e := raw.Control(func(fd uintptr) { bindErr = syscall.SetsockoptInt(int(fd), level, option, int(index)) })
		if e != nil {
			return e
		}
		return bindErr
	}
}
