package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestDecideConsent(t *testing.T) {
	cases := []struct{ name, verdict string; helper, timedOut bool; behavior string; wantProceed bool; wantReason string }{
		{"allow", "allow", true, false, "proceed", true, "user"},
		{"deny-proceedFallback", "deny", true, false, "proceed", false, "user"},
		{"deny-blockFallback", "deny", true, false, "block", false, "user"},
		{"timeout-proceed", "", true, true, "proceed", true, "timeout"},   // proceed but reason=timeout
		{"timeout-block", "", true, true, "block", false, "timeout"},
		{"noHelper-proceed", "", false, false, "proceed", true, "helper_absent"},
		{"noHelper-block", "", false, false, "block", false, "helper_absent"},
		// A present, responsive helper with no valid decision fails CLOSED
		// regardless of unavailable-behavior — "proceed" must NOT grant here.
		{"noUser-proceedIgnored", "", true, false, "proceed", false, "no_user"},
		{"noUser-block", "", true, false, "block", false, "no_user"},
		// An unrecognized verdict from a present helper is likewise fail-closed.
		{"invalidVerdict-proceedIgnored", "maybe", true, false, "proceed", false, "no_user"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			proceed, reason := decideConsent(c.verdict, c.helper, c.timedOut, c.behavior)
			if proceed != c.wantProceed || reason != c.wantReason {
				t.Fatalf("got (%v,%q) want (%v,%q)", proceed, reason, c.wantProceed, c.wantReason)
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
