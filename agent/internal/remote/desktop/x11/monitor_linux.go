//go:build linux

package x11

import (
	"github.com/jezek/xgb"
	"github.com/jezek/xgb/randr"
	"github.com/jezek/xgb/xproto"
)

// MonitorGeom is a display monitor's geometry (RandR 1.5).
type MonitorGeom struct {
	Name    string
	X, Y    int
	Width   int
	Height  int
	Primary bool
}

// Monitors queries RandR 1.5 GetMonitors, falling back to a single default
// monitor sized to the root screen when RandR is unavailable or reports none.
// Never returns an error — callers can always safely proceed with capture.
func Monitors(x *xgb.Conn, root xproto.Window, screenW, screenH int) ([]MonitorGeom, error) {
	if err := randr.Init(x); err != nil {
		return []MonitorGeom{{Name: "default", Width: screenW, Height: screenH, Primary: true}}, nil
	}
	reply, err := randr.GetMonitors(x, root, true).Reply()
	if err != nil || len(reply.Monitors) == 0 {
		return []MonitorGeom{{Name: "default", Width: screenW, Height: screenH, Primary: true}}, nil
	}
	out := make([]MonitorGeom, 0, len(reply.Monitors))
	for _, m := range reply.Monitors {
		out = append(out, MonitorGeom{
			Name:    atomName(x, m.Name),
			X:       int(m.X),
			Y:       int(m.Y),
			Width:   int(m.Width),
			Height:  int(m.Height),
			Primary: m.Primary,
		})
	}
	return out, nil
}

// atomName resolves an X11 atom to its string name via a GetAtomName round
// trip. There is no shared atomName helper in this package — Task 8 dropped
// the equivalent for cursor names once xgb started decoding
// GetCursorImageAndNameReply.Name to a Go string directly, so it never needed
// one. RandR's MonitorInfo.Name is still atom-valued, so this query is
// resolved locally here. Returns "" on error or for the null atom.
func atomName(x *xgb.Conn, atom xproto.Atom) string {
	if atom == 0 {
		return ""
	}
	reply, err := xproto.GetAtomName(x, atom).Reply()
	if err != nil || reply == nil {
		return ""
	}
	return reply.Name
}
