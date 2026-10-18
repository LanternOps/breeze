//go:build linux

package patching

import "testing"

// TestLinuxDesktopWiresEverySeam: the wiring is the one part of the Linux
// vehicle the untagged tests cannot see. A nil wall here would quietly turn
// the headless fallback (#9181) back into a log line.
func TestLinuxDesktopWiresEverySeam(t *testing.T) {
	if linuxDesktop.listSessions == nil || linuxDesktop.zenityAvailable == nil ||
		linuxDesktop.prompt == nil || linuxDesktop.notify == nil || linuxDesktop.wall == nil {
		t.Fatalf("linuxDesktop has an unwired seam: %+v", linuxDesktop)
	}
}
