//go:build linux

package sessionbroker

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/patching/linuxsession"
)

// NewLinuxDesktopHelperManagerForHost wires the manager to this host: the
// systemd-run spawner, explicit loginctl lookups, the logind session list
// and linuxsession's Wayland socket resolution.
func NewLinuxDesktopHelperManagerForHost(b *Broker, hooks LinuxDesktopHooks) (*LinuxDesktopHelperManager, error) {
	if b == nil {
		return nil, errors.New("linux desktop helper manager needs a session broker")
	}
	lookup := b.linuxLogindLookup
	if lookup == nil {
		lookup = lookupLinuxLogindSession
	}
	m := newLinuxDesktopHelperManager(b, newSystemdRunSpawner(), lookup, linuxGraphicalSessions, hooks, time.Now)
	m.waylandDisplay = linuxSessionWaylandDisplay
	m.attach()
	return m, nil
}

// linuxGraphicalSessions lists the local graphical user sessions through
// linuxsession, which resolves loginctl from the fixed system directories
// (never PATH). The user names it returns go into `systemd-run -M <user>@`.
func linuxGraphicalSessions(ctx context.Context) ([]DetectedSession, error) {
	sessions, err := linuxsession.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]DetectedSession, 0, len(sessions))
	for _, s := range sessions {
		uid, err := strconv.ParseUint(s.UID, 10, 32)
		if err != nil {
			continue
		}
		out = append(out, DetectedSession{UID: uint32(uid), Username: s.Username, Session: s.ID, LogindType: s.Type})
	}
	return out, nil
}

// linuxSessionWaylandDisplay finds the Wayland socket name of one logind
// session through linuxsession, which resolves it in the session's runtime
// directory.
func linuxSessionWaylandDisplay(ctx context.Context, logindSessionID string, uid uint32) (string, error) {
	sessions, err := linuxsession.List(ctx)
	if err != nil {
		return "", err
	}
	want := strconv.FormatUint(uint64(uid), 10)
	for _, s := range sessions {
		if s.ID != logindSessionID {
			continue
		}
		if s.UID != want || s.Type != linuxsession.TypeWayland {
			return "", errors.New("session is not this user's Wayland session")
		}
		if !linuxWaylandDisplayPattern.MatchString(s.Display) {
			return "", errors.New("session has no usable Wayland display")
		}
		return s.Display, nil
	}
	return "", errors.New("session not found among graphical sessions")
}
