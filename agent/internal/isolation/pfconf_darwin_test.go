//go:build darwin

package isolation

import (
	"context"
	"slices"
	"testing"
)

// Reads this host's interface list and changes nothing. Traffic can leave any
// live interface, not only the one holding the default route, so a set skip on
// a second NIC is a hole wherever the default route points.
func TestExecPFRunnerEgressInterfacesExcludesLoopback(t *testing.T) {
	names, err := execPFRunner{ctx: context.Background()}.EgressInterfaces()
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(names, "lo0") {
		t.Fatalf("loopback is not egress: %v", names)
	}
}
