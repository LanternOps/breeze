//go:build darwin && cgo

package userhelper

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
)

// maybeRequestScreenRecording must never raise the macOS consent dialog when we
// already have Screen Recording access, and must not raise it more than once
// per screenRecordingRequestInterval when we don't. Calling the prompting API
// (CGRequestScreenCaptureAccess) unconditionally at the top of the check loop is
// what produced one system dialog per helper start in #4327, multiplied by the
// launchd respawn loop in #4194. An unverified state (#8390, macOS 26+) must
// not ask either: the host may already be granted.
func TestMaybeRequestScreenRecording(t *testing.T) {
	now := time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name string
		// granted is what the non-capturing check reports.
		granted bool
		// unknown makes the check report an unverified state instead.
		unknown bool
		// marker is the timestamp already recorded, or nil for no marker file.
		marker *time.Time
		// markerBody overrides marker with raw file content.
		markerBody      string
		wantRequest     bool
		wantMarkerStamp string
	}{
		{
			name:            "already granted, no marker — never prompts",
			granted:         true,
			wantRequest:     false,
			wantMarkerStamp: "",
		},
		{
			name:            "already granted, stale marker — still never prompts",
			granted:         true,
			marker:          timePtr(now.Add(-72 * time.Hour)),
			wantRequest:     false,
			wantMarkerStamp: now.Add(-72 * time.Hour).Format(time.RFC3339),
		},
		{
			name:            "not granted, no marker — prompts and records it",
			granted:         false,
			wantRequest:     true,
			wantMarkerStamp: now.Format(time.RFC3339),
		},
		{
			name:            "not granted, recent marker — stays quiet",
			granted:         false,
			marker:          timePtr(now.Add(-1 * time.Hour)),
			wantRequest:     false,
			wantMarkerStamp: now.Add(-1 * time.Hour).Format(time.RFC3339),
		},
		{
			name:            "not granted, stale marker — prompts again and refreshes",
			granted:         false,
			marker:          timePtr(now.Add(-25 * time.Hour)),
			wantRequest:     true,
			wantMarkerStamp: now.Format(time.RFC3339),
		},
		{
			name:            "not granted, unparseable marker — prompts and repairs marker",
			granted:         false,
			markerBody:      "not-a-timestamp",
			wantRequest:     true,
			wantMarkerStamp: now.Format(time.RFC3339),
		},
		{
			name:            "unverified, no marker — never prompts",
			unknown:         true,
			wantRequest:     false,
			wantMarkerStamp: "",
		},
		{
			name:            "unverified, stale marker — still never prompts",
			unknown:         true,
			marker:          timePtr(now.Add(-72 * time.Hour)),
			wantRequest:     false,
			wantMarkerStamp: now.Add(-72 * time.Hour).Format(time.RFC3339),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			markerPath := filepath.Join(t.TempDir(), "screen-recording-requested")
			switch {
			case tt.markerBody != "":
				writeMarker(t, markerPath, tt.markerBody)
			case tt.marker != nil:
				writeMarker(t, markerPath, tt.marker.Format(time.RFC3339))
			}

			requested := false
			restore := stubScreenRecordingFns(t, accessReport(tt.granted, tt.unknown), func() bool {
				requested = true
				return tt.granted
			})
			defer restore()

			maybeRequestScreenRecording(ipc.DesktopContextUserSession, markerPath, now)

			if requested != tt.wantRequest {
				t.Errorf("prompting API called = %v, want %v", requested, tt.wantRequest)
			}

			data, err := os.ReadFile(markerPath)
			if tt.wantMarkerStamp == "" {
				if !os.IsNotExist(err) {
					t.Errorf("expected no marker file, got content %q err %v", data, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("reading marker: %v", err)
			}
			if string(data) != tt.wantMarkerStamp {
				t.Errorf("marker = %q, want %q", data, tt.wantMarkerStamp)
			}
		})
	}
}

// accessReport builds the non-capturing check's answer for a test.
func accessReport(granted, unknown bool) desktop.CaptureAccessReport {
	switch {
	case unknown:
		return desktop.CaptureAccessReport{State: desktop.CaptureAccessUnknown, Reason: "unverified"}
	case granted:
		return desktop.CaptureAccessReport{State: desktop.CaptureAccessGranted, Reason: "preflight"}
	}
	return desktop.CaptureAccessReport{State: desktop.CaptureAccessDenied, Reason: "preflight"}
}

func stubScreenRecordingFns(t *testing.T, report desktop.CaptureAccessReport, request func() bool) func() {
	t.Helper()
	origAccess, origRequest := captureAccessFn, requestScreenRecordingFn
	captureAccessFn = func(string) desktop.CaptureAccessReport { return report }
	requestScreenRecordingFn = request
	return func() {
		captureAccessFn = origAccess
		requestScreenRecordingFn = origRequest
	}
}

func writeMarker(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatalf("seeding marker: %v", err)
	}
}

func timePtr(v time.Time) *time.Time { return &v }

// #8058 addendum: only the desktop helper's loop raises the Screen Recording
// consent dialog; `breeze-agent user-helper` must not, even when the
// permission is missing and the rate-limit marker is absent.
func TestRequestScreenRecordingAtLoopStart_OnlyDesktopHelper(t *testing.T) {
	for _, tc := range []struct {
		kind string
		want bool
	}{
		{ipc.HelperBinaryDesktopHelper, true},
		{ipc.HelperBinaryUserHelper, false},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			requested := false
			restore := stubScreenRecordingFns(t, accessReport(false, false), func() bool { requested = true; return false })
			defer restore()
			markerPath := filepath.Join(t.TempDir(), "screen-recording-requested")

			requestScreenRecordingAtLoopStart(tccLoopPolicyFor(tc.kind), ipc.DesktopContextUserSession, markerPath, time.Now())

			if requested != tc.want {
				t.Fatalf("consent dialog requested = %v, want %v", requested, tc.want)
			}
		})
	}
}
