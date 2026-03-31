//go:build darwin

package collectors

import (
	"fmt"
	"strings"
	"testing"
)

func TestParseNetstatOutputCapsAndTruncates(t *testing.T) {
	c := NewConnectionsCollector()
	longAddr := strings.Repeat("a", collectorStringLimit+32)

	var output strings.Builder
	output.WriteString("Active Internet connections\n")
	for i := 0; i < collectorResultLimit+10; i++ {
		fmt.Fprintf(&output, "tcp4 0 0 %s.%d %s.%d ESTABLISHED 0 0 0 %d\n", longAddr, 1000+i, longAddr, 2000+i, i+1)
	}

	connections := c.parseNetstatOutput([]byte(output.String()), "tcp")
	if len(connections) != collectorResultLimit {
		t.Fatalf("expected %d connections, got %d", collectorResultLimit, len(connections))
	}
	if !strings.Contains(connections[0].LocalAddr, "[truncated]") {
		t.Fatalf("expected truncated local address, got %q", connections[0].LocalAddr)
	}
}
