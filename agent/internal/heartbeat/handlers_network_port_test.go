package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// The SNMP port narrows to uint16; with GetPayloadInt now accepting numeric
// strings (issue #3373) an out-of-range value must be rejected up front, not
// wrapped onto a different port. The invalid values return before any network
// I/O is attempted, which is what makes this safe to run in a unit test.
func TestHandleSnmpPollRejectsOutOfRangePort(t *testing.T) {
	for _, port := range []any{0, -1, 65536, 1 << 20, "70000"} {
		result := handleSnmpPoll(nil, Command{
			ID:   "cmd-1",
			Type: tools.CmdSnmpPoll,
			Payload: map[string]any{
				"target": "192.0.2.1",
				"port":   port,
			},
		})

		if result.Status != "failed" {
			t.Fatalf("port %#v: status = %q, want failed", port, result.Status)
		}
		if !strings.Contains(result.Error, "port must be 1-65535") {
			t.Errorf("port %#v: error %q should name the port range", port, result.Error)
		}
	}
}
