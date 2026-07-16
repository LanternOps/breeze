//go:build windows

package agentapp

import (
	"fmt"
	"os"
)

func writeInstanceGuardMarker(startup ProcessStartup, guardErr error) {
	message := fmt.Sprintf(
		"Breeze main-agent instance guard failure: pid=%d parentPid=%d windowsSessionId=%d launchMode=%s binary=%q version=%q error=%v",
		startup.PID,
		startup.ParentPID,
		startup.WindowsSessionID,
		startup.LaunchMode,
		startup.Binary,
		startup.Version,
		guardErr,
	)
	if err := writeInstanceGuardEventFn("BreezeAgent", message); err != nil {
		fmt.Fprintf(os.Stderr, "Breeze instance-guard Event Log marker failed: %v\n", err)
	}
}
