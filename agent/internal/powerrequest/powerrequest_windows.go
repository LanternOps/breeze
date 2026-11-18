//go:build windows

package powerrequest

import (
	"fmt"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modkernel32            = windows.NewLazySystemDLL("kernel32.dll")
	procPowerCreateRequest = modkernel32.NewProc("PowerCreateRequest")
	procPowerSetRequest    = modkernel32.NewProc("PowerSetRequest")
	procPowerClearRequest  = modkernel32.NewProc("PowerClearRequest")
)

// From winnt.h / minwinbase.h.
const (
	powerRequestContextVersion      = 0 // POWER_REQUEST_CONTEXT_VERSION
	powerRequestContextSimpleString = 0x1
	powerRequestSystemRequired      = 1 // POWER_REQUEST_TYPE PowerRequestSystemRequired
)

// reasonContext is REASON_CONTEXT with Flags = POWER_REQUEST_CONTEXT_SIMPLE_STRING.
// The Reason union is as large as its Detailed member (HMODULE, ULONG, ULONG,
// LPWSTR*); the padding keeps the struct that size on 32- and 64-bit Windows,
// though only SimpleReasonString is read with this flag.
type reasonContext struct {
	Version            uint32
	Flags              uint32
	SimpleReasonString *uint16
	_                  [2]uint32
	_                  uintptr
}

func holdSystemAwake(reason string) (func(), error) {
	if err := procPowerCreateRequest.Find(); err != nil {
		return nil, fmt.Errorf("power requests unavailable: %w", err)
	}
	text, err := windows.UTF16PtrFromString(reason)
	if err != nil {
		return nil, fmt.Errorf("power request reason: %w", err)
	}
	ctx := reasonContext{
		Version:            powerRequestContextVersion,
		Flags:              powerRequestContextSimpleString,
		SimpleReasonString: text,
	}
	r, _, callErr := procPowerCreateRequest.Call(uintptr(unsafe.Pointer(&ctx)))
	runtime.KeepAlive(text)
	handle := windows.Handle(r)
	if handle == windows.InvalidHandle || handle == 0 {
		return nil, fmt.Errorf("PowerCreateRequest: %w", callErr)
	}
	if ok, _, callErr := procPowerSetRequest.Call(uintptr(handle), powerRequestSystemRequired); ok == 0 {
		_ = windows.CloseHandle(handle)
		return nil, fmt.Errorf("PowerSetRequest(SystemRequired): %w", callErr)
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			// Closing the handle alone drops the request; clearing first makes
			// the release explicit and visible in `powercfg /requests` at once.
			_, _, _ = procPowerClearRequest.Call(uintptr(handle), powerRequestSystemRequired)
			_ = windows.CloseHandle(handle)
			// The documentation does not say whether PowerCreateRequest copies
			// the reason string, so keep the buffer alive while the request
			// is held.
			runtime.KeepAlive(text)
		})
	}, nil
}
