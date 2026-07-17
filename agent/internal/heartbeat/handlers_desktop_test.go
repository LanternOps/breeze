package heartbeat

import (
	"runtime"
	"strings"
	"testing"
)

func TestHandleStartDesktopLinuxNotSupportedYet(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("linux-only interim guard")
	}
	h := &Heartbeat{}
	res := handleStartDesktop(h, Command{
		ID: "c1",
		Payload: map[string]any{
			"sessionId": "11111111-1111-1111-1111-111111111111",
			"offer":     "v=0\r\n",
		},
	})
	if res.Status != "failed" || !strings.Contains(res.Error, "not yet supported on Linux") {
		t.Fatalf("expected linux-not-supported failure, got status=%q error=%q", res.Status, res.Error)
	}
}
