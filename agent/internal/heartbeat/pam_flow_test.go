package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestRunPamFlow(t *testing.T) {
	approved := ipc.PamDialogResult{Approved: true}
	dismissed := ipc.PamDialogResult{Approved: false, DismissedByUser: true}

	cases := []struct {
		name          string
		status        string
		dialog        ipc.PamDialogResult
		noSession     bool
		wantTriggered bool
		wantDismissed bool
		// wantActuated asserts the promote→demote credential pipeline ran.
		wantActuated bool
	}{
		{
			name:          "policy hard-deny dismisses without dialog",
			status:        "denied",
			dialog:        approved, // ignored — denied short-circuits before the dialog
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "auto-approved + user-approved actuates",
			status:        "auto_approved",
			dialog:        approved,
			wantTriggered: true,
			wantDismissed: false,
			wantActuated:  true,
		},
		{
			name:          "auto-approved + user-dismissed denies",
			status:        "auto_approved",
			dialog:        dismissed,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "pending + user-approved awaits remote",
			status:        "pending",
			dialog:        approved,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			name:          "pending + user-dismissed denies",
			status:        "pending",
			dialog:        dismissed,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "auto-approved but no capable session shows nothing",
			status:        "auto_approved",
			dialog:        approved,
			noSession:     true,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var triggered, dismissed bool
			swapActuatorForTest(t, func() pamactuator.Actuator {
				return fakeActuator{
					trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
						triggered = true
						return pamactuator.Result{Success: true, Reason: "ok"}
					},
					dismiss: func(context.Context) pamactuator.Result {
						dismissed = true
						return pamactuator.Result{Success: true, Reason: "dismissed"}
					},
				}
			})

			manager := &fakeElevationManager{
				cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"},
			}
			swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

			var dialogCalled bool
			h := &Heartbeat{
				pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
					if capability != ipc.ScopePam {
						t.Fatalf("FindCapableSession capability = %q, want %q", capability, ipc.ScopePam)
					}
					if tc.noSession {
						return nil
					}
					return &sessionbroker.Session{}
				},
				pamRequestDialog: func(_ *sessionbroker.Session, _ string, _ ipc.PamRequestDialog, _ time.Duration) (ipc.PamDialogResult, error) {
					dialogCalled = true
					return tc.dialog, nil
				},
			}

			ev := etwlua.Event{
				SubjectUsername:        "CORP\\\\alice",
				TargetExecutablePath:   `C:\Windows\regedit.exe`,
				TargetExecutableHash:   "abc123",
				TargetExecutableSigner: "Microsoft Windows",
				CommandLine:            `regedit.exe`,
			}
			outcome := etwlua.ElevationOutcome{RequestID: "req-1", Status: tc.status}

			h.RunPamFlow(context.Background(), ev, outcome)

			if triggered != tc.wantTriggered {
				t.Errorf("triggered = %v, want %v", triggered, tc.wantTriggered)
			}
			if dismissed != tc.wantDismissed {
				t.Errorf("dismissed = %v, want %v", dismissed, tc.wantDismissed)
			}

			// The "denied" status must short-circuit before the dialog is shown.
			if tc.status == "denied" && dialogCalled {
				t.Errorf("policy hard-deny showed the dialog; should short-circuit")
			}

			// The actuate path runs Promote then a deferred Demote.
			wantPromote, wantDemote := 0, 0
			if tc.wantActuated {
				wantPromote, wantDemote = 1, 1
			}
			if manager.promoteSeen != wantPromote {
				t.Errorf("Promote called %d times, want %d", manager.promoteSeen, wantPromote)
			}
			if manager.demoteSeen != wantDemote {
				t.Errorf("Demote called %d times, want %d", manager.demoteSeen, wantDemote)
			}
		})
	}
}
