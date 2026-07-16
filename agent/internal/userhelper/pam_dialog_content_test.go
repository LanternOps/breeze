package userhelper

import (
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestPamDialogHeadline(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{"windows path", `C:\Windows\System32\msiexec.exe`, "msiexec.exe is requesting elevation"},
		{"forward slashes", `/usr/local/bin/tool`, "tool is requesting elevation"},
		{"bare name", "setup.exe", "setup.exe is requesting elevation"},
		{"empty", "", "An application is requesting elevation"},
		{"trailing separator", `C:\Windows\`, "An application is requesting elevation"},
		{"nul bytes stripped", "evil\x00.exe", "evil .exe is requesting elevation"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pamDialogHeadline(ipc.PamRequestDialog{ExePath: tt.path})
			if got != tt.want {
				t.Errorf("pamDialogHeadline(%q) = %q, want %q", tt.path, got, tt.want)
			}
		})
	}
}

func TestPamDialogFields(t *testing.T) {
	t.Run("required fields with unknown placeholders", func(t *testing.T) {
		fields := pamDialogFields(ipc.PamRequestDialog{})
		if len(fields) != 3 {
			t.Fatalf("expected 3 fields, got %d: %+v", len(fields), fields)
		}
		for i, want := range []string{"Program", "Signer", "User"} {
			if fields[i].Label != want {
				t.Errorf("field %d label = %q, want %q", i, fields[i].Label, want)
			}
			if fields[i].Value != "Unknown" {
				t.Errorf("field %d value = %q, want Unknown", i, fields[i].Value)
			}
		}
	})

	t.Run("optional fields appear when populated", func(t *testing.T) {
		fields := pamDialogFields(ipc.PamRequestDialog{
			ExePath:       `C:\tools\x.exe`,
			Signer:        "Contoso Ltd",
			SubjectUser:   `ACME\jsmith`,
			CommandLine:   "/i driver.msi",
			Reason:        "printer driver",
			IntentSummary: "install a driver",
		})
		labels := make([]string, len(fields))
		for i, f := range fields {
			labels[i] = f.Label
		}
		want := []string{"Program", "Signer", "User", "Command line", "Reason", "Intent"}
		if strings.Join(labels, ",") != strings.Join(want, ",") {
			t.Errorf("labels = %v, want %v", labels, want)
		}
	})

	t.Run("blank command line omitted", func(t *testing.T) {
		fields := pamDialogFields(ipc.PamRequestDialog{CommandLine: "   "})
		for _, f := range fields {
			if f.Label == "Command line" {
				t.Errorf("blank command line should be omitted, got %+v", fields)
			}
		}
	})
}

func TestBuildPamDialogBody(t *testing.T) {
	body := buildPamDialogBody(ipc.PamRequestDialog{
		ExePath:     `C:\x.exe`,
		Signer:      "Contoso",
		SubjectUser: "jsmith",
		CommandLine: "/quiet",
	})
	wantLines := []string{
		"Breeze detected an elevation request.",
		"",
		`Program: C:\x.exe`,
		"Signer: Contoso",
		"User: jsmith",
		"Command line: /quiet",
		"",
		"Approve this elevation request?",
	}
	if body != strings.Join(wantLines, "\r\n") {
		t.Errorf("body mismatch:\n%q", body)
	}
}

func TestFormatPamCountdown(t *testing.T) {
	tests := []struct {
		remaining time.Duration
		want      string
	}{
		{90 * time.Second, "1:30"},
		{65 * time.Second, "1:05"},
		{59 * time.Second, "0:59"},
		{0, "0:00"},
		{-5 * time.Second, "0:00"},
		{10 * time.Minute, "10:00"},
	}
	for _, tt := range tests {
		if got := formatPamCountdown(tt.remaining); got != tt.want {
			t.Errorf("formatPamCountdown(%v) = %q, want %q", tt.remaining, got, tt.want)
		}
	}
}
