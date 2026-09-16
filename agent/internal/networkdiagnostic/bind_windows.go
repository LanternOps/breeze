//go:build windows

package networkdiagnostic

import (
	"encoding/binary"
	"golang.org/x/sys/windows"
	"syscall"
)

func bindInterface(index uint32, ipv6 bool) func(string, string, syscall.RawConn) error {
	return func(_, _ string, raw syscall.RawConn) error {
		level, option, value := windows.IPPROTO_IP, 31, index
		if ipv6 {
			level = windows.IPPROTO_IPV6
		} else {
			var b [4]byte
			binary.BigEndian.PutUint32(b[:], index)
			value = binary.NativeEndian.Uint32(b[:])
		}
		var bindErr error
		e := raw.Control(func(fd uintptr) { bindErr = windows.SetsockoptInt(windows.Handle(fd), level, option, int(value)) })
		if e != nil {
			return e
		}
		return bindErr
	}
}
