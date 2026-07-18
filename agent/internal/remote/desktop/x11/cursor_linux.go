//go:build linux

package x11

import (
	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xfixes"
)

// CursorTracker owns a dedicated X connection for high-frequency cursor
// polling so it never contends with the capture connection (mirrors the old
// cgo design, which opened a separate Display* purely for cursor queries).
type CursorTracker struct {
	owner *Conn
	x     *xgb.Conn
}

// NewCursorTracker opens a second connection to the same target for cursor
// polls. It never captures, so it uses the bare (no-SHM) open path.
func NewCursorTracker(target DisplayTarget) (*CursorTracker, error) {
	c, err := OpenBare(target)
	if err != nil {
		return nil, err
	}
	if err := xfixes.Init(c.x); err != nil {
		_ = c.Close()
		return nil, err
	}
	// XFixes requires a version negotiation before any cursor request.
	if _, err := xfixes.QueryVersion(c.x, 4, 0).Reply(); err != nil {
		_ = c.Close()
		return nil, err
	}
	return &CursorTracker{owner: c, x: c.x}, nil
}

// Poll returns the cursor position, its X11 name (for CSS mapping), and validity.
//
// xgb v1.3.1's GetCursorImageAndNameReply already decodes the cursor name to a
// Go string (it round-trips XInternAtom under the hood on the server side and
// wire-encodes the resulting text directly in the reply's Name field); there is
// a CursorAtom field too, but no separate xproto.GetAtomName round trip is
// needed to resolve it to text.
func (t *CursorTracker) Poll() (x, y int, name string, ok bool) {
	reply, err := xfixes.GetCursorImageAndName(t.x).Reply()
	if err != nil || reply == nil {
		return 0, 0, "", false
	}
	return int(reply.X), int(reply.Y), reply.Name, true
}

// Close releases the dedicated cursor connection.
func (t *CursorTracker) Close() { _ = t.owner.Close() }
