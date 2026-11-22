package netattach

import (
	"bytes"
	"net"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

// hardwareInterface is one interface Windows flags as hardware-backed
// (MIB_IF_ROW2 HardwareInterface), as read by deps_windows.go.
type hardwareInterface struct {
	Index uint32
	MAC   string
	Up    bool
}

// windowsBridgedUplink is the Windows bridged-uplink fact (plan K2, Task 2
// candidate A). The interface kinds put a Hyper-V external vEthernet, an
// internal or NAT vEthernet and TAP-style VPN adapters all under "virtual".
// The external vEthernet carries the MAC of the physical NIC its switch is
// bound to; an internal or Default Switch vEthernet has a MAC of its own. So a
// virtual row has a physical uplink when its MAC equals the MAC of another,
// up, hardware interface. Only "virtual" rows qualify.
func windowsBridgedUplink(row networkcontext.InterfaceRow, hw []hardwareInterface) bool {
	if row.Kind != "virtual" {
		return false
	}
	mac, err := net.ParseMAC(row.CurrentMAC)
	if err != nil || len(mac) != 6 || bytes.Equal(mac, make(net.HardwareAddr, 6)) {
		return false
	}
	for _, h := range hw {
		if !h.Up || h.Index == row.OSIndex {
			continue
		}
		other, err := net.ParseMAC(h.MAC)
		if err == nil && bytes.Equal(mac, other) {
			return true
		}
	}
	return false
}
