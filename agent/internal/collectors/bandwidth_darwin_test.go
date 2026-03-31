//go:build darwin

package collectors

import "testing"

func TestGetLinkSpeedRejectsInvalidInterfaceName(t *testing.T) {
	t.Parallel()

	if got := getLinkSpeed("../bad0"); got != 0 {
		t.Fatalf("getLinkSpeed rejected invalid interface name incorrectly: %d", got)
	}
}
