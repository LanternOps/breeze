package userhelper

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/tccdiag"
)

// #10300: a denial carries its one-word cause to the agent; a healthy status
// carries nothing and costs no diagnosis.
func TestAttachDenialVerdict(t *testing.T) {
	cases := []struct {
		name         string
		status       ipc.TCCStatus
		wantServices []tccdiag.Service
		wantVerdict  string
	}{
		{"all granted", ipc.TCCStatus{ScreenRecordingState: "granted", Accessibility: true}, nil, ""},
		// macOS 26: preflight can misreport, so unknown is not a denial.
		{"screen recording unverified", ipc.TCCStatus{ScreenRecordingState: "unknown", Accessibility: true}, nil, ""},
		{"screen recording denied", ipc.TCCStatus{ScreenRecordingState: "denied", Accessibility: true},
			[]tccdiag.Service{tccdiag.ServiceScreenCapture}, "requirement_mismatch"},
		{"accessibility denied", ipc.TCCStatus{ScreenRecordingState: "granted", Accessibility: false},
			[]tccdiag.Service{tccdiag.ServiceAccessibility}, "requirement_mismatch"},
		{"both denied", ipc.TCCStatus{ScreenRecordingState: "denied", Accessibility: false},
			[]tccdiag.Service{tccdiag.ServiceScreenCapture, tccdiag.ServiceAccessibility}, "requirement_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var got []tccdiag.Service
			calls := 0
			save := tccDiagnoseFn
			t.Cleanup(func() { tccDiagnoseFn = save })
			tccDiagnoseFn = func(services []tccdiag.Service) tccdiag.Diagnosis {
				calls++
				got = services
				return tccdiag.Diagnosis{Verdict: tccdiag.VerdictRequirementMismatch}
			}

			status := tc.status
			attachDenialVerdict(&status)

			if status.DenialVerdict != tc.wantVerdict {
				t.Fatalf("DenialVerdict = %q, want %q", status.DenialVerdict, tc.wantVerdict)
			}
			if tc.wantServices == nil && calls != 0 {
				t.Fatalf("diagnosed a status with no denial (%d calls)", calls)
			}
			if tc.wantServices != nil && (calls != 1 || !reflect.DeepEqual(got, tc.wantServices)) {
				t.Fatalf("diagnosed %v in %d calls, want %v once", got, calls, tc.wantServices)
			}
		})
	}
}

func TestAttachDenialVerdictNilStatus(t *testing.T) {
	attachDenialVerdict(nil)
}
