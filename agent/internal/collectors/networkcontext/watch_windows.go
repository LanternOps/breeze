//go:build windows

package networkcontext

import (
	"context"
	"golang.org/x/sys/windows"
	"syscall"
	"unsafe"
)

func WatchChanges(ctx context.Context, notify func()) error {
	events := make(chan struct{}, 1)
	callback := windows.NewCallback(func(_ uintptr, _ uintptr, _ uint32) uintptr {
		select {
		case events <- struct{}{}:
		default:
		}
		return 0
	})
	cancel := ipHelper.NewProc("CancelMibChangeNotify2")
	handles := []windows.Handle{}
	defer func() {
		for _, handle := range handles {
			_, _, _ = cancel.Call(uintptr(handle))
		}
	}()
	for _, name := range []string{"NotifyRouteChange2", "NotifyUnicastIpAddressChange", "NotifyIpInterfaceChange"} {
		var handle windows.Handle
		code, _, _ := ipHelper.NewProc(name).Call(windows.AF_UNSPEC, callback, 0, 0, uintptr(unsafe.Pointer(&handle)))
		if code != 0 {
			return syscall.Errno(code)
		}
		handles = append(handles, handle)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-events:
			notify()
		}
	}
}
