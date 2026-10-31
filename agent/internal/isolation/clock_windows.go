//go:build windows

package isolation

import (
	"fmt"
	"sync"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var procGetTickCount64 = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetTickCount64")

// systemMono is GetTickCount64: milliseconds since boot, counting sleep and
// hibernation.
func systemMono() time.Duration {
	if err := procGetTickCount64.Find(); err != nil {
		return processMono()
	}
	ms, _, _ := procGetTickCount64.Call()
	return time.Duration(ms) * time.Millisecond
}

var bootIDOnce = sync.OnceValue(func() string {
	// The kernel increments BootId on every boot (Windows 8+).
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management\PrefetchParameters`, registry.QUERY_VALUE)
	if err == nil {
		defer func() { _ = k.Close() }()
		if id, _, err := k.GetIntegerValue("BootId"); err == nil {
			return fmt.Sprintf("windows:%d", id)
		}
	}
	if procGetTickCount64.Find() != nil {
		return processBootID()
	}
	// Fall back to the boot time, rounded so tick-count jitter is absorbed.
	boot := time.Now().Add(-systemMono()).Truncate(time.Minute)
	return fmt.Sprintf("windows-boottime:%d", boot.Unix())
})

func systemBootID() string { return bootIDOnce() }
