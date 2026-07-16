//go:build !windows

package agentapp

import (
	"fmt"
	"os"
)

func writeInstanceGuardMarker(startup ProcessStartup, guardErr error) {
	_ = writeInstanceGuardEventFn(
		"BreezeAgent",
		fmt.Sprintf(
			"Breeze main-agent instance guard failure: pid=%d launchMode=%s error=%v",
			startup.PID,
			startup.LaunchMode,
			guardErr,
		),
	)
	fmt.Fprintf(
		os.Stderr,
		"Breeze main-agent instance guard failure (pid=%d mode=%s): %v\n",
		startup.PID,
		startup.LaunchMode,
		guardErr,
	)
}
