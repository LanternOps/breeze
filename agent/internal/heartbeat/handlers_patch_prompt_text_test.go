package heartbeat

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

// newTestHeartbeatCapturingNotices is newTestHeartbeatWithRebootManager with the
// notification seam recorded, so the lead rung (which fires at offset zero, on a
// real timer) can be read back.
func newTestHeartbeatCapturingNotices(t *testing.T) (*Heartbeat, <-chan [2]string) {
	t.Helper()
	notices := make(chan [2]string, 16)
	mgr := patching.NewRebootManager(func(title, body, _ string) {
		notices <- [2]string{title, body}
	}, 3)
	t.Cleanup(mgr.Stop)
	return &Heartbeat{rebootMgr: mgr}, notices
}

func firstNotice(t *testing.T, notices <-chan [2]string) [2]string {
	t.Helper()
	select {
	case n := <-notices:
		return n
	case <-time.After(5 * time.Second):
		t.Fatal("the lead rung never fired")
		return [2]string{}
	}
}

// #8030: the payload's prompt text reaches the warning the user sees.
func TestScheduleRebootRendersTheCustomPromptText(t *testing.T) {
	h, notices := newTestHeartbeatCapturingNotices(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
		"promptTitle": "Neustart geplant", "promptBody": "Neustart in {{countdown}}.",
		"promptButton": "Jetzt neu starten",
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	got := firstNotice(t, notices)
	if got[0] != "Neustart geplant" || got[1] != "Neustart in 15 minutes." {
		t.Errorf("lead notice = %q / %q", got[0], got[1])
	}
}

// #8030: no prompt keys — an old API, or a policy with no text — is today's
// copy, byte for byte.
func TestScheduleRebootWithoutPromptTextKeepsTheBuiltInCopy(t *testing.T) {
	h, notices := newTestHeartbeatCapturingNotices(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	got := firstNotice(t, notices)
	want := [2]string{"Restart Scheduled", "A system restart for updates is scheduled in 15 minutes. Please save your work."}
	if got != want {
		t.Errorf("lead notice = %q, want %q", got, want)
	}
}

// #8030: invalid text is dropped, never rendered — and never costs the user
// the reboot or its warning.
func TestScheduleRebootDropsInvalidPromptTextButStillSchedules(t *testing.T) {
	h, notices := newTestHeartbeatCapturingNotices(t)
	res := handleScheduleReboot(h, Command{Payload: map[string]any{
		"delayMinutes": float64(15), "reason": "Patch", "source": "patch_job",
		"promptTitle": "<b>Restart</b>", "promptBody": "Body {{countdown}}",
		"promptButton": float64(42),
	}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	if !h.rebootMgr.State().RebootScheduled {
		t.Fatal("invalid prompt text cost the reboot")
	}
	got := firstNotice(t, notices)
	if got[0] != "Restart Scheduled" || got[1] != "Body 15 minutes" {
		t.Errorf("lead notice = %q / %q", got[0], got[1])
	}
}

func TestRebootPromptTextFromPayload(t *testing.T) {
	got := rebootPromptTextFromPayload(map[string]any{
		"promptTitle": " T ", "promptBody": "B", "promptButton": "Btn",
	})
	if got != (patching.RebootPromptText{Title: "T", Body: "B", Button: "Btn"}) {
		t.Errorf("got %+v", got)
	}
	if got := rebootPromptTextFromPayload(map[string]any{
		"promptTitle": true, "promptBody": []any{"x"}, "promptButton": strings.Repeat("a", 41),
	}); got != (patching.RebootPromptText{}) {
		t.Errorf("non-string / over-length fields survived: %+v", got)
	}
}
