package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// decideConsent is the consent gate's decision matrix. Only a click is a user
// decision. An expired countdown counts only when the prompt was confirmed on
// screen and the user could see it. A prompt that could not be shown proceeds
// only when nobody is signed in to the captured session; when someone is (or
// that cannot be told) it is always refused, whatever the policy says.
func TestDecideConsent(t *testing.T) {
	occ := func(o string) func() string { return func() string { return o } }
	visible := func() bool { return true }
	hidden := func() bool { return false }
	cases := []struct {
		name        string
		att         consentAttempt
		behavior    string
		occupancy   func() string
		visible     func() bool
		wantProceed bool
		wantReason  string
		wantOcc     string
		wantDetail  string
	}{
		{"granted", consentAttempt{outcome: ipc.ConsentOutcomeGranted}, "block", nil, visible, true, "user", "", ""},
		{"denied under proceed", consentAttempt{outcome: ipc.ConsentOutcomeDenied}, "proceed", nil, visible, false, "user", "", ""},
		{"denied under block", consentAttempt{outcome: ipc.ConsentOutcomeDenied}, "block", nil, visible, false, "user", "", ""},
		{"shown and expired, proceed", consentAttempt{outcome: ipc.ConsentOutcomePresentedExpired}, "proceed", nil, visible, true, "timeout", "", ""},
		{"shown and expired, block", consentAttempt{outcome: ipc.ConsentOutcomePresentedExpired}, "block", nil, visible, false, "timeout", "", ""},
		{"expired on a locked or disconnected screen is not an unanswered prompt", consentAttempt{outcome: ipc.ConsentOutcomePresentedExpired}, "proceed", occ(occupancyOccupied), hidden, false, "helper_unreachable", occupancyOccupied, "prompt_not_visible"},
		{"expired, unknown behavior fails closed", consentAttempt{outcome: ipc.ConsentOutcomePresentedExpired}, "", nil, visible, false, "timeout", "", ""},
		{"not shown, nobody signed in, proceed", consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "no_helper"}, "proceed", occ(occupancyUnoccupied), visible, true, "no_user_session", occupancyUnoccupied, "no_helper"},
		{"not shown, nobody signed in, block", consentAttempt{outcome: ipc.ConsentOutcomeUnavailable}, "block", occ(occupancyUnoccupied), visible, false, "no_user_session", occupancyUnoccupied, ""},
		// A connected consent helper lives in a signed-in user's session, so
		// the session is occupied whatever the detector says.
		{"not shown by a connected helper is occupied, whatever the detector says", consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "no_presentation", helper: &sessionbroker.Session{}}, "proceed", func() string { return occupancyUnoccupied }, visible, false, "helper_unreachable", occupancyOccupied, "no_presentation"},
		{"not shown, someone signed in, proceed ignored", consentAttempt{outcome: ipc.ConsentOutcomeUnavailable}, "proceed", occ(occupancyOccupied), visible, false, "helper_unreachable", occupancyOccupied, ""},
		{"not shown, cannot tell who is signed in, proceed ignored", consentAttempt{outcome: ipc.ConsentOutcomeUnavailable}, "proceed", occ(occupancyUnknown), visible, false, "helper_unreachable", occupancyUnknown, ""},
		{"shown but no valid answer", consentAttempt{outcome: consentOutcomeUnknown}, "proceed", nil, visible, false, "no_user", "", ""},
		{"garbage outcome", consentAttempt{outcome: "maybe"}, "proceed", nil, visible, false, "no_user", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			occupancy := c.occupancy
			if occupancy == nil {
				occupancy = func() string { t.Fatal("occupancy must not be evaluated for this outcome"); return "" }
			}
			v := decideConsent(c.att, c.behavior, occupancy, c.visible)
			if v.proceed != c.wantProceed || v.reason != c.wantReason {
				t.Fatalf("got (%v,%q) want (%v,%q)", v.proceed, v.reason, c.wantProceed, c.wantReason)
			}
			if v.occupancy != c.wantOcc {
				t.Fatalf("occupancy = %q, want %q", v.occupancy, c.wantOcc)
			}
			if v.detail != c.wantDetail {
				t.Fatalf("detail = %q, want %q", v.detail, c.wantDetail)
			}
			if v.outcome != c.att.outcome {
				t.Fatalf("outcome = %q, want the attempt's %q", v.outcome, c.att.outcome)
			}
		})
	}
}

func TestConnectedNotifyBody(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	tests := []struct {
		name   string
		prompt *ipc.DesktopPrompt
		want   string
	}{
		{"name and partner", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy"), OrgName: strPtr("Olive Technology")}, "Billy from Olive Technology connected to your computer"},
		{"name only", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy")}, "Billy connected to your computer"},
		{"partner only (generic identity)", &ipc.DesktopPrompt{OrgName: strPtr("Olive Technology")}, "A technician from Olive Technology connected to your computer"},
		{"neither", &ipc.DesktopPrompt{}, "A technician connected to your computer"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connectedNotifyBody(tt.prompt); got != tt.want {
				t.Errorf("connectedNotifyBody() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBannerLabel(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	tests := []struct {
		name   string
		prompt *ipc.DesktopPrompt
		want   string
	}{
		{"name and partner", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy"), OrgName: strPtr("Olive Technology")}, "Billy from Olive Technology is connected"},
		{"name only", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy")}, "Billy is connected"},
		{"partner only", &ipc.DesktopPrompt{OrgName: strPtr("Olive Technology")}, "A technician from Olive Technology is connected"},
		{"neither", &ipc.DesktopPrompt{}, "A technician is connected"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := bannerLabel(tt.prompt); got != tt.want {
				t.Errorf("bannerLabel() = %q, want %q", got, tt.want)
			}
		})
	}
}
