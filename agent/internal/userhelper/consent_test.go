package userhelper

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBuildConsentDialogText(t *testing.T) {
	tests := []struct {
		name     string
		req      ipc.ConsentRequest
		wantBody []string // substrings that must appear
		notBody  []string // substrings that must NOT appear
	}{
		{
			"full identity",
			ipc.ConsentRequest{TechnicianName: "Billy", TechnicianEmail: "billy@olive.co", OrgName: "Olive Technology"},
			[]string{"Billy (billy@olive.co) from Olive Technology", "requesting remote access"},
			nil,
		},
		{
			"name only",
			ipc.ConsentRequest{TechnicianName: "Billy"},
			[]string{"Billy is requesting remote access"},
			[]string{"()", " from "},
		},
		{
			"generic with partner",
			ipc.ConsentRequest{OrgName: "Olive Technology"},
			[]string{"A technician from Olive Technology is requesting remote access"},
			nil,
		},
		{
			"fully generic",
			ipc.ConsentRequest{},
			[]string{"A technician is requesting remote access"},
			nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			title, body := buildConsentDialogText(tt.req)
			if title != "Remote Support Request" {
				t.Errorf("title = %q", title)
			}
			for _, want := range tt.wantBody {
				if !strings.Contains(body, want) {
					t.Errorf("body %q missing %q", body, want)
				}
			}
			for _, not := range tt.notBody {
				if strings.Contains(body, not) {
					t.Errorf("body %q must not contain %q", body, not)
				}
			}
		})
	}
}

func TestSanitizeConsentRequest(t *testing.T) {
	long := strings.Repeat("x", 5000)
	req := sanitizeConsentRequest(ipc.ConsentRequest{
		TechnicianName: "  Billy\x00 ", TechnicianEmail: long, OrgName: long,
		TimeoutMs: 99_999_999, OnTimeout: "PROCEED",
	})
	if strings.ContainsAny(req.TechnicianName, "\x00") || req.TechnicianName != "Billy" {
		t.Errorf("name not sanitized: %q", req.TechnicianName)
	}
	if len(req.TechnicianEmail) > maxNotifyTitleBytes || len(req.OrgName) > maxNotifyTitleBytes {
		t.Error("email/org not truncated")
	}
	if req.TimeoutMs != maxConsentTimeoutMs {
		t.Errorf("timeout not clamped: %d", req.TimeoutMs)
	}
	if req.OnTimeout != "proceed" {
		t.Errorf("onTimeout not normalized: %q", req.OnTimeout)
	}
}

func TestConsentDecisionMapping(t *testing.T) {
	tests := []struct {
		name      string
		allow     bool
		answered  bool
		onTimeout string
		want      string
	}{
		{"user allowed", true, true, "block", "allow"},
		{"user denied", false, true, "proceed", "deny"},
		{"timeout with proceed", false, false, "proceed", "allow"}, // mirrors Tauri ConsentDialog.tsx
		{"timeout with block", false, false, "block", "deny"},
		{"timeout with unknown behavior fails closed", false, false, "", "deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consentDecision(tt.allow, tt.answered, tt.onTimeout); got != tt.want {
				t.Errorf("consentDecision() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestShowConsentDialogFnInjectable(t *testing.T) {
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	called := false
	showConsentDialogFn = func(req ipc.ConsentRequest) (bool, bool) {
		called = true
		return true, true
	}
	allow, answered := showConsentDialogFn(ipc.ConsentRequest{})
	if !called || !allow || !answered {
		t.Fatal("injection seam broken")
	}
}
