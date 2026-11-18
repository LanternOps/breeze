//go:build windows

package userhelper

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// SHQueryUserNotificationState (shell32, Vista+) reports whether the user is
// presenting, full screen, in quiet time or away (#10190 W04). The decision
// it feeds is noticeDeliveryFor (notice_delivery.go, untagged and tested on
// every OS); this file only makes the call.
var (
	noticeShell32                    = windows.NewLazySystemDLL("shell32.dll")
	procSHQueryUserNotificationState = noticeShell32.NewProc("SHQueryUserNotificationState")
)

// platformNotificationState is the native renderer's notification-state
// query on Windows.
var platformNotificationState = queryUserNotificationState

func queryUserNotificationState() (uint32, error) {
	if err := procSHQueryUserNotificationState.Find(); err != nil {
		return 0, fmt.Errorf("SHQueryUserNotificationState unavailable: %w", err)
	}
	var state uint32
	hr, _, _ := procSHQueryUserNotificationState.Call(uintptr(unsafe.Pointer(&state)))
	if int32(hr) < 0 {
		return 0, fmt.Errorf("SHQueryUserNotificationState failed: HRESULT 0x%08X", uint32(hr))
	}
	return state, nil
}
