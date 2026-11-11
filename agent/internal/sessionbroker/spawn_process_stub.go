//go:build !windows

package sessionbroker

import (
	"fmt"
	"time"
)

// SpawnProcessInSessionWithArgs is only implemented on Windows.
func SpawnProcessInSessionWithArgs(_ string, _ []string, _ uint32) (uint32, error) {
	return 0, fmt.Errorf("SpawnProcessInSessionWithArgs not supported on this platform")
}

// RunProcessInSessionWithArgs is only implemented on Windows.
func RunProcessInSessionWithArgs(_ string, _ []string, _ uint32, _ time.Duration) (uint32, error) {
	return 0, fmt.Errorf("RunProcessInSessionWithArgs not supported on this platform")
}
