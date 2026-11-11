//go:build darwin

package security

import (
	"sync"
	"syscall"
)

// The OS version cannot change without a reboot, which restarts the agent.
var cachedMacOSMajor = sync.OnceValues(func() (int, bool) {
	v, err := syscall.Sysctl("kern.osproductversion")
	if err != nil {
		return 0, false
	}
	return parseMacOSMajor(v)
})

func hostMacOSMajorVersion() (int, bool) { return cachedMacOSMajor() }
