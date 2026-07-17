//go:build linux

package desktop

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/desktop/x11"
)

func TestListMonitorsLinux(t *testing.T) {
	if _, err := x11.SelectX11Target(); err != nil {
		t.Skipf("no X display: %v", err)
	}
	mons, err := ListMonitors()
	if err != nil {
		t.Fatalf("ListMonitors: %v", err)
	}
	if len(mons) == 0 {
		t.Fatal("expected at least one monitor")
	}
	if mons[0].Width == 0 || mons[0].Height == 0 {
		t.Fatalf("bad monitor geometry: %+v", mons[0])
	}
}
