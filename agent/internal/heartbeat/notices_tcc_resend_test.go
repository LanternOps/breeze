package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// #12794 review: on a native helper the permission notice is a dialog that
// gives up after 60 s, can be taken down by a decision, and has no list to
// come back from. Left open for its 24 h lifetime it would hide Open
// Settings for a day, and without it the person cannot grant Full Disk
// Access. An unanswered notice is shown again once it has been open for
// permissionNoticeResendAfter, at the next status report.
func TestTCCNoticeComesBackWhenLeftUnansweredOnANativeHelper(t *testing.T) {
	clock := &shiftClock{}
	probe := tccSession(t, true) // a native user helper: no list
	h := noticeHeartbeatAt(t, clock, []string{"notice.info"}, probe)
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice")
	first := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[0])
	raw, _ := json.Marshal(ipc.PromptPresented{PromptID: first.PromptID, Rev: first.Rev, Lease: first.Lease, Visible: true})
	h.promptHost.HandleRendererMessage(probe.session, ipc.TypePromptPresented, raw)

	// Before the interval: the open notice is not re-sent (decided in
	// handleTCCNotice, before anything is queued for the helper).
	clock.advance(permissionNoticeResendAfter - time.Minute)
	if h.tccNoticeDue(probe.session, first.PromptID) {
		t.Fatal("due before its re-send interval")
	}

	// The dialog gave up unanswered long ago: the next report shows it again.
	clock.advance(2 * time.Minute)
	if !h.tccNoticeDue(probe.session, first.PromptID) {
		t.Fatal("not due after its re-send interval on a helper with no list")
	}
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 2 }, "the notice shown again")
	again := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[1])
	if again.PromptID != first.PromptID || again.Rev <= first.Rev {
		t.Fatalf("re-sent %s rev %d after %s rev %d", again.PromptID, again.Rev, first.PromptID, first.Rev)
	}
	open := false
	for _, a := range again.Actions {
		open = open || a.ID == "open_settings"
	}
	if !open {
		t.Fatalf("the re-sent notice lost Open Settings: %+v", again.Actions)
	}
	// The interval starts again from the re-send.
	if h.tccNoticeDue(probe.session, first.PromptID) {
		t.Fatal("due again right after the re-send")
	}
}

// Breeze Assist keeps the notice in its list, where Open Settings stays
// reachable: it is not re-sent there before it expires.
func TestTCCNoticeOnAssistIsNotResent(t *testing.T) {
	if tccNoticeResendable(prompthost.PlacementInfo{Path: prompthost.PathPrompt, Role: ipc.HelperRoleAssist}) {
		t.Fatal("a notice in Assist's list was re-sent")
	}
	for _, info := range []prompthost.PlacementInfo{
		{Path: prompthost.PathPrompt, Role: ipc.HelperRoleUser},
		{Path: prompthost.PathLegacy},
		{Path: prompthost.PathNone},
	} {
		if !tccNoticeResendable(info) {
			t.Fatalf("%+v: a notice with no list to come back from is never re-sent", info)
		}
	}
}
