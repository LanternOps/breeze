//go:build windows

package heartbeat

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ipAdapterDHCPEnabled is IP_ADAPTER_DHCP_ENABLED from iptypes.h. x/sys does
// not export the IP_ADAPTER_* flag constants.
const ipAdapterDHCPEnabled = 0x00000004

// readDHCPEnabledAliasesIPHelper reads DHCPv4 state for every adapter with
// IPv4 enabled through GetAdaptersAddresses, in-process (#7765). This is the
// same data Get-NetIPInterface -AddressFamily IPv4 exposes as .Dhcp, without
// starting a child process or a CIM query. Keys are lower-cased, trimmed friendly
// names: the InterfaceAlias that Go's net.Interfaces (and so the inventory
// collector) reports as the interface name.
func readDHCPEnabledAliasesIPHelper() (map[string]bool, error) {
	const flags = windows.GAA_FLAG_SKIP_UNICAST | windows.GAA_FLAG_SKIP_ANYCAST |
		windows.GAA_FLAG_SKIP_MULTICAST | windows.GAA_FLAG_SKIP_DNS_SERVER
	size := uint32(15000)
	for attempt := 0; attempt < 3; attempt++ {
		if size > 1024*1024 {
			return nil, fmt.Errorf("GetAdaptersAddresses: buffer request %d bytes exceeds limit", size)
		}
		buf := make([]byte, size)
		head := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0]))
		err := windows.GetAdaptersAddresses(windows.AF_INET, flags, 0, head, &size)
		if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
			continue
		}
		if errors.Is(err, windows.ERROR_NO_DATA) {
			// No adapter has IPv4 enabled: nothing is DHCP-enabled.
			return map[string]bool{}, nil
		}
		if err != nil {
			return nil, fmt.Errorf("GetAdaptersAddresses: %w", err)
		}
		aliases := map[string]bool{}
		for a := head; a != nil; a = a.Next {
			name := strings.ToLower(strings.TrimSpace(windows.UTF16PtrToString(a.FriendlyName)))
			if name == "" {
				continue
			}
			// Two adapters can share a friendly name; like the old
			// Where-Object filter, DHCP on either one counts.
			aliases[name] = aliases[name] || a.Flags&ipAdapterDHCPEnabled != 0
		}
		runtime.KeepAlive(buf)
		return aliases, nil
	}
	return nil, errors.New("GetAdaptersAddresses: buffer still too small after 3 attempts")
}
