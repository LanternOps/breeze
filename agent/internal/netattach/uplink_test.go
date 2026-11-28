package netattach

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

func TestWindowsBridgedUplink(t *testing.T) {
	nic := hardwareInterface{Index: 4, MAC: "00:1a:8c:00:00:01", Up: true}
	downNIC := nic
	downNIC.Up = false
	row := func(kind, mac string, index uint32) networkcontext.InterfaceRow {
		return networkcontext.InterfaceRow{InterfaceKey: "k", OSIndex: index, Name: "vEthernet", Kind: kind, CurrentMAC: mac}
	}
	for _, tc := range []struct {
		name string
		row  networkcontext.InterfaceRow
		hw   []hardwareInterface
		want bool
	}{
		{"external switch shares the NIC's MAC", row("virtual", "00:1a:8c:00:00:01", 12), []hardwareInterface{nic}, true},
		{"MAC compared without regard to case", row("virtual", "00:1A:8C:00:00:01", 12), []hardwareInterface{nic}, true},
		{"NAT or internal switch has its own MAC", row("virtual", "3c:37:86:aa:bb:10", 12), []hardwareInterface{nic}, false},
		{"matching NIC is down", row("virtual", "00:1a:8c:00:00:01", 12), []hardwareInterface{downNIC}, false},
		{"virtual row without a MAC", row("virtual", "", 12), []hardwareInterface{nic}, false},
		{"the row is the NIC itself", row("virtual", "00:1a:8c:00:00:01", 4), []hardwareInterface{nic}, false},
		{"tunnel kind never", row("tunnel", "00:1a:8c:00:00:01", 12), []hardwareInterface{nic}, false},
		{"bridge kind is not a Windows uplink", row("bridge", "00:1a:8c:00:00:01", 12), []hardwareInterface{nic}, false},
		{"all-zero MAC never matches", row("virtual", "00:00:00:00:00:00", 12), []hardwareInterface{{Index: 5, MAC: "00:00:00:00:00:00", Up: true}}, false},
		{"no hardware interfaces", row("virtual", "00:1a:8c:00:00:01", 12), nil, false},
		{"hardware entry without a MAC never matches", row("virtual", "", 12), []hardwareInterface{{Index: 5, Up: true}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := windowsBridgedUplink(tc.row, tc.hw); got != tc.want {
				t.Fatalf("windowsBridgedUplink(%+v, %+v) = %v, want %v", tc.row, tc.hw, got, tc.want)
			}
		})
	}
}
