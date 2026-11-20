//go:build linux

package sessionbroker

import (
	"context"
	"fmt"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

// LinuxActiveSeatSession returns the logind session active on the local
// seat, or nil when the seat has none. loginctl is resolved from the fixed
// system directories, never PATH. It spawns nothing else and changes nothing.
func LinuxActiveSeatSession(ctx context.Context) (*DetectedSession, error) {
	loginctl, err := linuxsession.ResolveSystemBinary("loginctl")
	if err != nil {
		return nil, fmt.Errorf("resolve loginctl: %w", err)
	}
	seatOut, err := runLoginctl(ctx, loginctl, "show-seat", linuxDesktopSeat, "--property=ActiveSession")
	if err != nil {
		return nil, fmt.Errorf("loginctl show-seat %s: %w", linuxDesktopSeat, err)
	}
	id, ok := parseLogindSeatActiveSession(seatOut)
	if !ok {
		return nil, fmt.Errorf("loginctl show-seat %s: unreadable ActiveSession", linuxDesktopSeat)
	}
	if id == "" {
		return nil, nil
	}
	out, err := runLoginctl(ctx, loginctl, "show-session", id,
		"--property=Id", "--property=User", "--property=Type", "--property=State", "--property=Class", "--property=Remote")
	if err != nil {
		return nil, fmt.Errorf("loginctl show-session %s: %w", id, err)
	}
	return activeSeatDetectedSession(id, parseLogindShowSession(id, out)), nil
}
