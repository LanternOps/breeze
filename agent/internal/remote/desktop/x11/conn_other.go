//go:build !linux

package x11

// Conn is unavailable off Linux.
type Conn struct{}

// Open is unsupported off Linux.
func Open(target DisplayTarget) (*Conn, error) { return nil, ErrNoDisplay }

func (c *Conn) Bounds() (int, int)                               { return 0, 0 }
func (c *Conn) CaptureBGRX() ([]byte, int, int, error)           { return nil, 0, 0, ErrNoDisplay }
func (c *Conn) CaptureRegionBGRX(x, y, w, h int) ([]byte, error) { return nil, ErrNoDisplay }
func (c *Conn) Close() error                                     { return nil }
