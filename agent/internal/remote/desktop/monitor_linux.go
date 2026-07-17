//go:build linux

package desktop

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

// ListMonitors enumerates monitors on the resolved X display via RandR.
// Falls back to a single default monitor if RandR itself reports none (see
// x11.Monitors), but returns an error when no X display is attachable at
// all — mirroring the Windows ListMonitors contract that existing callers
// (applyDisplayOffset, the list_monitors control command, GetScreenResolution)
// already handle.
func ListMonitors() ([]MonitorInfo, error) {
	target, err := x11.SelectX11Target()
	if err != nil {
		return nil, fmt.Errorf("select x11 target: %w", err)
	}
	conn, err := x11.Open(target)
	if err != nil {
		return nil, fmt.Errorf("open x11 connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	w, h := conn.Bounds()
	geoms, err := x11.Monitors(conn.XConn(), conn.Root(), w, h)
	if err != nil || len(geoms) == 0 {
		return []MonitorInfo{{Index: 0, Name: "Default", Width: w, Height: h, IsPrimary: true}}, nil
	}

	mons := make([]MonitorInfo, 0, len(geoms))
	for i, g := range geoms {
		name := g.Name
		if name == "" {
			name = "Monitor"
		}
		mons = append(mons, MonitorInfo{
			Index:     i,
			Name:      name,
			Width:     g.Width,
			Height:    g.Height,
			X:         g.X,
			Y:         g.Y,
			IsPrimary: g.Primary,
		})
	}
	return mons, nil
}
