//go:build linux

package syscleanup

import (
	"fmt"
	"golang.org/x/sys/unix"
)

// probeWritable reports whether this process can write inside path.
//
// Spec §7.2: defence in depth for self-hosters who harden the systemd unit
// themselves. Verified 2026-09-19 that the shipped agent unit
// (agent/internal/agentapp/systemd_unit.go, agent/service/systemd/
// breeze-agent.service) carries no ProtectSystem / ReadWritePaths — only the
// WATCHDOG unit is ProtectSystem=strict — so this is not a known blocker, and
// reporting the reason is more useful than failing mid-run with EROFS.
func probeWritable(path string) (bool, string) {
	if err := unix.Access(path, unix.W_OK); err != nil {
		return false, fmt.Sprintf("sandbox denies write to %s", path)
	}
	return true, ""
}
