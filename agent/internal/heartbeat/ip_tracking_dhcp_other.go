//go:build !windows

package heartbeat

import "errors"

// readDHCPEnabledAliasesIPHelper is Windows-only; hasDHCPLease calls
// windowsDHCPLeaseEvidence only when runtime.GOOS is "windows".
func readDHCPEnabledAliasesIPHelper() (map[string]bool, error) {
	return nil, errors.New("IP Helper DHCP read is only available on Windows")
}
