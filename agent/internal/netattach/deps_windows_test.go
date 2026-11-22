//go:build windows

package netattach

import (
	"context"
	"net"
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

// The Windows uplink reader runs here even on a runner with no virtual rows,
// where Current would never call it.
func TestReadHardwareInterfaces_Live(t *testing.T) {
	hw, err := readHardwareInterfaces()
	if err != nil {
		t.Fatalf("readHardwareInterfaces: %v", err)
	}
	for _, h := range hw {
		mac, err := net.ParseMAC(h.MAC)
		if err != nil || len(mac) != 6 || h.Index == 0 {
			t.Errorf("hardware interface %+v: index 0 or bad MAC (%v)", h, err)
		}
	}
	t.Logf("%d hardware interfaces", len(hw))

	m, err := windowsBridged(context.Background(), []networkcontext.InterfaceRow{{InterfaceKey: "k", Kind: "virtual", CurrentMAC: "3c:37:86:aa:bb:10", OSIndex: 1 << 30}})
	if err != nil || len(m) != 1 {
		t.Fatalf("windowsBridged = %v, %v", m, err)
	}
}
