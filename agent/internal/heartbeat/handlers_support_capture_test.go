package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// In a Quick Support session the user sees who is viewing their screen only
// while a desktop session runs, so one-shot screen captures and input
// (take_screenshot, computer_action) are refused there rather than run
// without that indicator.
func TestSupportSessionRefusesOneShotScreenCaptureAndInput(t *testing.T) {
	for _, cmdType := range []string{tools.CmdTakeScreenshot, tools.CmdComputerAction} {
		t.Run(cmdType, func(t *testing.T) {
			h := &Heartbeat{supportMode: true}
			handler := handlerRegistry[cmdType]
			if handler == nil {
				t.Fatalf("no handler registered for %s", cmdType)
			}
			res := handler(h, Command{ID: "c1", Type: cmdType, Payload: map[string]any{"action": "screenshot"}})
			if res.Status != "failed" || !strings.Contains(res.Error, "Quick Support") {
				t.Fatalf("%s in a support session: status %q error %q, want a failed result naming Quick Support", cmdType, res.Status, res.Error)
			}
		})
	}
}
