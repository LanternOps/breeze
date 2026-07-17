//go:build linux

package x11

// ProbeCapture is an honest capability probe: it resolves the display and then
// actually opens (connect + auth) the resolved target, immediately closing it.
// It never captures a frame — it uses the bare (no-SHM) path purely to verify
// the connection can be established, so it is cheap enough to run per heartbeat.
//
// A resolver error (ErrNoDisplay, ErrWaylandUnsupported) is returned as-is; a
// post-resolve failure returns the classified Open error, which is one of
// ErrConnectFailed (socket unreachable) or ErrAuthFailed (handshake/auth
// rejected).
func ProbeCapture() error {
	target, err := SelectX11Target()
	if err != nil {
		return err
	}
	conn, err := OpenBare(target)
	if err != nil {
		return err
	}
	_ = conn.Close()
	return nil
}
