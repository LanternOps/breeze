//go:build !linux && !darwin && !windows

package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

func watchdogExecutableName() string { return "breeze-watchdog" }

func registerVerifiedWatchdog(string) error { return watchdoginstall.ErrUnsupportedOS }

func waitWatchdogRunning(time.Duration) bool { return false }
