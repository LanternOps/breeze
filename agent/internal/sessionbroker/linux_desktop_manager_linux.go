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
	detector := NewSessionDetector()
	list := func(context.Context) ([]DetectedSession, error) { return detector.ListSessions() }
	m := newLinuxDesktopHelperManager(b, newSystemdRunSpawner(), lookup, list, hooks, time.Now)
	m.waylandDisplay = linuxSessionWaylandDisplay
	m.attach()
	return m, nil
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
