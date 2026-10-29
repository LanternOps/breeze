package userhelper

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #10190 W07 (plan P14): the SYSTEM helper renders elevation.request@1's
// first question with the PAM window on the input desktop. Its logic lives
// in untagged files so CI tests it on every OS.

func TestSystemHelperAdvertisesElevationOnWindowsOnly(t *testing.T) {
	for _, tc := range []struct {
		goos     string
		protocol int
		kinds    []string
	}{
		{"windows", ipc.PromptProtocolVersion, []string{"elevation.request@1"}},
		{"darwin", 0, []string{}},
		{"linux", 0, []string{}},
	} {
		protocol, kinds := NativePromptAdvertisementOn(ipc.HelperRoleSystem, tc.goos, true)
		if protocol != tc.protocol || !reflect.DeepEqual(kinds, tc.kinds) {
			t.Fatalf("%s: SYSTEM advertises protocol %d kinds %v, want %d %v", tc.goos, protocol, kinds, tc.protocol, tc.kinds)
		}
	}
	// The user helper never advertises elevation (the broker would refuse
	// it for that role anyway).
	_, kinds := NativePromptAdvertisementOn(ipc.HelperRoleUser, "windows", true)
	for _, k := range kinds {
		if k == "elevation.request@1" {
			t.Fatal("the user helper advertised elevation.request")
		}
	}
}

func TestLegacyPamDialogContentIsUnchanged(t *testing.T) {
	req := ipc.PamRequestDialog{ExePath: `C:\Temp\setup.exe`, Signer: "Contoso", SubjectUser: `PC\dana`, TimeoutSeconds: 90}
	c := pamDialogContentFromRequest(req)
	if c.Headline != "setup.exe is requesting elevation" || c.Subline != "Breeze intercepted an elevation request on this device." {
		t.Fatalf("legacy headline/subline = %q / %q", c.Headline, c.Subline)
	}
	if c.ApproveLabel != "&Approve" || c.DenyLabel != "&Deny" || c.Total != 90*time.Second {
		t.Fatalf("legacy labels/countdown = %q %q %v", c.ApproveLabel, c.DenyLabel, c.Total)
	}
	if !reflect.DeepEqual(c.Fields, pamDialogFields(req)) {
		t.Fatalf("legacy fields = %+v", c.Fields)
	}
}

func elevationFirstQuestionShow() ipc.PromptShow {
	return ipc.PromptShow{
		PromptID: "elevation:7e1e0000-0000-4000-8000-000000010221", Rev: 1,
		Lease: ipc.PromptLease{RendererSession: "system-1", Epoch: 1},
		Kind:  "elevation.request", KindVersion: 1,
		State: ipc.PromptStatePending, Presentation: ipc.PromptPresentationModal,
		Copy: ipc.PromptCopy{Title: "Request administrator access?", Body: "7zFM.exe needs administrator rights. Send a request to Northwind IT?"},
		Facts: []ipc.PromptFact{
			{Label: "Program", Value: "7zFM.exe"},
			{Label: "Publisher", Value: "Igor Pavlov"},
		},
		Actions: []ipc.PromptAction{
			{ID: "cancel", Label: "Cancel", Role: ipc.PromptRoleSafe},
			{ID: "send_request", Label: "Send request", Role: ipc.PromptRoleProceed},
		},
		DefaultActionID: "cancel",
		Timing:          ipc.PromptTiming{PresentWithinMs: 10_000, ResponseMs: 90_000, Expiry: &ipc.PromptExpiry{Text: "If you don't answer within {remaining}, the request is not sent."}},
		Focus:           ipc.PromptFocusSteal,
		ListEntry:       ipc.PromptListEntry{Persistent: true},
		Locale:          "en",
		Direction:       "ltr",
	}
}

func TestSystemPromptContentFromTheModel(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	m, err := buildNativePromptModel(elevationFirstQuestionShow(), now, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	c, err := pamDialogContentFromModel(m)
	if err != nil {
		t.Fatal(err)
	}
	if c.Headline != "Request administrator access?" || c.Subline != "7zFM.exe needs administrator rights. Send a request to Northwind IT?" {
		t.Fatalf("headline/subline = %q / %q", c.Headline, c.Subline)
	}
	want := []pamDialogField{{Label: "Program", Value: "7zFM.exe"}, {Label: "Publisher", Value: "Igor Pavlov"}}
	if !reflect.DeepEqual(c.Fields, want) {
		t.Fatalf("fields = %+v", c.Fields)
	}
	if c.ApproveLabel != "Send request" || c.DenyLabel != "Cancel" || c.ApproveID != "send_request" || c.DenyID != "cancel" {
		t.Fatalf("buttons = %+v", c)
	}
	if c.Total != 90*time.Second {
		t.Fatalf("countdown = %v", c.Total)
	}
	if c.Note != "If you don't answer within 1:30, the request is not sent." {
		t.Fatalf("note = %q", c.Note)
	}
}

func TestSystemPromptContentRefusesAnythingButATwoButtonDecision(t *testing.T) {
	s := elevationFirstQuestionShow()
	s.State, s.Presentation = ipc.PromptStateWaiting, ipc.PromptPresentationCard
	s.Actions = []ipc.PromptAction{{ID: "cancel_request", Label: "Cancel request", Role: ipc.PromptRoleSafe}, {ID: "hide", Label: "Hide", Role: ipc.PromptRoleNeutral}}
	s.DefaultActionID = "hide"
	s.Timing = ipc.PromptTiming{PresentWithinMs: 10_000}
	m, err := buildNativePromptModel(s, time.Now(), time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pamDialogContentFromModel(m); err == nil {
		t.Fatal("the SYSTEM helper draws only the first question (a safe and a proceed button)")
	}
}

func TestSystemPromptOutcome(t *testing.T) {
	m, _ := buildNativePromptModel(elevationFirstQuestionShow(), time.Now(), time.UTC)
	c, _ := pamDialogContentFromModel(m)
	for _, tc := range []struct {
		res  ipc.PamDialogResult
		want nativeOutcome
	}{
		{ipc.PamDialogResult{Approved: true}, nativeOutcome{ActionID: "send_request"}},
		{ipc.PamDialogResult{Approved: false, DismissedByUser: true}, nativeOutcome{ActionID: "cancel"}},
		{ipc.PamDialogResult{Approved: false, DismissedByUser: false}, nativeOutcome{TimedOut: true}},
	} {
		if got := systemPromptOutcome(c, tc.res); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%+v -> %+v, want %+v", tc.res, got, tc.want)
		}
	}
}

// Never re-show natively blindly: the prompt renderer draws only on the
// desktop that has input now; if it cannot attach to it, nothing is drawn
// (render_failed), unlike today's dialog, which falls back to its own
// desktop.
func TestStrictInputDesktopNeverFallsBack(t *testing.T) {
	errDesktop := errors.New("desktop operation failed")
	for _, tc := range []struct {
		name      string
		configure func(*fakePamDesktopOps)
		wantCalls []string
	}{
		{"current desktop lookup failure", func(o *fakePamDesktopOps) { o.currentErr = errDesktop }, []string{"lock", "current", "unlock"}},
		{"input desktop open failure", func(o *fakePamDesktopOps) { o.openErr = errDesktop }, []string{"lock", "current", "open", "unlock"}},
		{"input desktop name failure", func(o *fakePamDesktopOps) { o.nameErr = errDesktop }, []string{"lock", "current", "open", "name:2", "close:2", "unlock"}},
		{"switch failure", func(o *fakePamDesktopOps) { o.setErrors[2] = errDesktop }, []string{"lock", "current", "open", "name:2", "set:2", "close:2", "unlock"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ops := newFakePamDesktopOps()
			tc.configure(ops)
			shown := false
			if runOnInputDesktop(ops, true, func(string) { shown = true }) {
				t.Fatal("reported drawn")
			}
			if shown || !reflect.DeepEqual(ops.calls, tc.wantCalls) {
				t.Fatalf("shown=%v calls=%v, want %v", shown, ops.calls, tc.wantCalls)
			}
		})
	}
	ops := newFakePamDesktopOps()
	var name string
	if !runOnInputDesktop(ops, true, func(n string) { name = n }) || name != "Winlogon" {
		t.Fatalf("success: name %q calls %v", name, ops.calls)
	}
}
