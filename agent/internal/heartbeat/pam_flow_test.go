package heartbeat

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
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
		name   string
		status etwlua.ElevationStatus
		dialog ipc.PamDialogResult
		// returnErr, when non-nil, is returned by the pamRequestDialog seam to
		// simulate a broker round-trip failure. RunPamFlow must coerce that to
		// deny+dismiss regardless of the (ignored) dialog result.
		returnErr error
		noSession bool
		// noBroker builds the heartbeat with nil swappable fields (pamFindSession,
		// pamRequestDialog) AND a nil sessionBroker, reproducing production wiring
		// where the broker is absent. Proves RunPamFlow never panics in that shape.
		noBroker bool
		// wantDialog asserts whether the broker dialog round-trip was reached.
		wantDialog    bool
		wantTriggered bool
		wantDismissed bool
		// wantActuated asserts the promote→demote credential pipeline ran.
		wantActuated bool
		// promoteErr, when non-nil, makes the fake elevation manager's Promote
		// fail. actuateElevation returns early (no Trigger, no deferred Demote),
		// proving RunPamFlow tolerates a failed actuation cleanly.
		promoteErr error
		// wantPromoteAttempt asserts Promote was called exactly once even though
		// the actuation did not complete (used with promoteErr).
		wantPromoteAttempt bool
		// dismissResult, when non-nil, overrides the fake actuator's Dismiss
		// return so the deny-path logging switch can be exercised against the
		// benign "no_consent_window" and the genuine-failure reasons.
		dismissResult *pamactuator.Result
	}{
		{
			name:          "policy hard-deny dismisses without dialog",
			status:        "denied",
			dialog:        approved, // ignored — denied short-circuits before the dialog
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "auto-approved + user-approved actuates",
			status:        "auto_approved",
			dialog:        approved,
			wantDialog:    true,
			wantTriggered: true,
			wantDismissed: false,
			wantActuated:  true,
		},
		{
			name:          "auto-approved + user-dismissed denies",
			status:        "auto_approved",
			dialog:        dismissed,
			wantDialog:    true,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "pending + user-approved awaits remote",
			status:        "pending",
			dialog:        approved,
			wantDialog:    true,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			name:          "pending + user-dismissed denies",
			status:        "pending",
			dialog:        dismissed,
			wantDialog:    true,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "auto-approved but no capable session shows nothing",
			status:        "auto_approved",
			dialog:        approved,
			noSession:     true,
			wantDialog:    false, // early return precedes the dialog round-trip
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			// Production wiring: sessionBroker is nil (only built when
			// UserHelperEnabled/IsService/IsHeadless), yet etwlua can still
			// fire. The defensive guard must skip the dialog path without panic.
			name:          "auto-approved with nil broker skips without panic",
			status:        "auto_approved",
			dialog:        approved,
			noBroker:      true,
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			// denied returns via denyConsent (Actuator.Dismiss, no broker)
			// BEFORE the nil-broker guard, so it must still dismiss cleanly.
			name:          "denied with nil broker still dismisses without panic",
			status:        "denied",
			dialog:        approved, // ignored
			noBroker:      true,
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			// Broker round-trip error must fail safe: even an APPROVED dialog
			// is overridden to deny+dismiss (pam_flow.go dialog-error branch).
			name:          "dialog round-trip error coerces to deny+dismiss",
			status:        "auto_approved",
			dialog:        approved, // overridden by the error path
			returnErr:     errors.New("broker pipe closed"),
			wantDialog:    true, // the ask(...) seam was reached (and errored)
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			// Unknown/future status hits the inert default branch: no dialog,
			// no actuation, no dismissal.
			name:          "unknown status is inert (default branch)",
			status:        "some_future_status",
			dialog:        approved, // ignored
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			// FIX I: auto-approved + user-approved, but the credential Promote
			// fails (e.g. ErrUnsupportedPlatform). actuateElevation returns the
			// failure early — Trigger is never reached as success, no Demote runs,
			// and no spurious dismiss occurs. Proves the local flow tolerates a
			// failed actuation cleanly without panicking.
			name:               "auto-approved promote failure tolerated, no dismiss",
			status:             "auto_approved",
			dialog:             approved,
			promoteErr:         elevaccount.ErrUnsupportedPlatform,
			wantDialog:         true,
			wantTriggered:      false, // Promote fails before Trigger
			wantDismissed:      false, // actuate path never dismisses
			wantActuated:       false, // promote→demote pipeline did not complete
			wantPromoteAttempt: true,  // Promote attempted exactly once
		},
		{
			// FIX B: deny path where Dismiss reports the prompt was already gone.
			// no_consent_window is the desired deny end-state, not a failure — the
			// flow must not panic and must still have invoked Dismiss. (The only
			// observable difference vs a hard failure is log level.)
			name:          "deny with dismiss no_consent_window is benign",
			status:        "denied",
			dialog:        approved, // ignored — denied short-circuits
			dismissResult: &pamactuator.Result{Success: false, Reason: "no_consent_window"},
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			// FIX B: deny path where Dismiss genuinely failed (send_input_failed).
			// This is the real "enforcement FAILED" case; the flow must still not
			// panic and must have invoked Dismiss.
			name:          "deny with dismiss send_input_failed does not panic",
			status:        "denied",
			dialog:        approved, // ignored
			dismissResult: &pamactuator.Result{Success: false, Reason: "send_input_failed"},
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var triggered, dismissed bool
			var gotRequest pamactuator.Request
			swapActuatorForTest(t, func() pamactuator.Actuator {
				return fakeActuator{
					trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
						triggered = true
						gotRequest = req
						return pamactuator.Result{Success: true, Reason: "ok"}
					},
					dismiss: func(context.Context) pamactuator.Result {
						dismissed = true
						if tc.dismissResult != nil {
							return *tc.dismissResult
						}
						return pamactuator.Result{Success: true, Reason: "dismissed"}
					},
				}
			})

			manager := &fakeElevationManager{
				cred:       elevaccount.Credential{Username: "~breeze_elev", Password: "x"},
				promoteErr: tc.promoteErr,
			}
			swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

			var dialogCalled bool
			var gotDialog ipc.PamRequestDialog
			var gotDialogTimeout time.Duration
			// noBroker reproduces production wiring: both swappable seams nil
			// AND a nil sessionBroker. The defensive guard in RunPamFlow must
			// keep this from dereferencing the nil broker.
			h := &Heartbeat{}
			if !tc.noBroker {
				h.pamFindSession = func(capability, targetWinSession string) *sessionbroker.Session {
					if capability != ipc.ScopePam {
						t.Fatalf("FindCapableSession capability = %q, want %q", capability, ipc.ScopePam)
					}
					if tc.noSession {
						return nil
					}
					return &sessionbroker.Session{}
				}
				h.pamRequestDialog = func(_ *sessionbroker.Session, _ string, req ipc.PamRequestDialog, timeout time.Duration) (ipc.PamDialogResult, error) {
					dialogCalled = true
					gotDialog = req
					gotDialogTimeout = timeout
					return tc.dialog, tc.returnErr
				}
			}

			// Distinct, recognizable field values so a transposition (e.g.
			// Signer↔Hash) in buildPamRequestDialog fails the mapping assertion.
			ev := etwlua.Event{
				SubjectUsername:        "CORP\\subjectuser",
				TargetExecutablePath:   `C:\path\to\target.exe`,
				TargetExecutableHash:   "hash-deadbeef",
				TargetExecutableSigner: "signer-Acme Corp",
				CommandLine:            `target.exe --do-thing`,
			}
			outcome := etwlua.ElevationOutcome{RequestID: "req-1", Status: tc.status}

			h.RunPamFlow(context.Background(), ev, outcome)

			if triggered != tc.wantTriggered {
				t.Errorf("triggered = %v, want %v", triggered, tc.wantTriggered)
			}
			if dismissed != tc.wantDismissed {
				t.Errorf("dismissed = %v, want %v", dismissed, tc.wantDismissed)
			}

			// The dialog round-trip must only be reached when expected: denied
			// short-circuits before it, and the no-session early return precedes
			// the ask(...) call. (With a nil broker the seam is never installed,
			// so dialogCalled stays false trivially.)
			if dialogCalled != tc.wantDialog {
				t.Errorf("dialogCalled = %v, want %v", dialogCalled, tc.wantDialog)
			}

			// The actuate path runs Promote then a deferred Demote. When Promote
			// fails (promoteErr), actuateElevation returns before registering the
			// Demote defer, so Promote is attempted once but Demote never runs.
			wantPromote, wantDemote := 0, 0
			if tc.wantActuated {
				wantPromote, wantDemote = 1, 1
			} else if tc.wantPromoteAttempt {
				wantPromote = 1 // promote attempted, then failed → no Demote
			}
			if manager.promoteSeen != wantPromote {
				t.Errorf("Promote called %d times, want %d", manager.promoteSeen, wantPromote)
			}
			if manager.demoteSeen != wantDemote {
				t.Errorf("Demote called %d times, want %d", manager.demoteSeen, wantDemote)
			}

			// FIX 3: whenever the dialog round-trip succeeds, assert the full
			// ETW-event → PamRequestDialog field mapping. This guards a
			// security-sensitive, compiler-invisible mapping (a Signer↔Hash
			// transposition would silently mislabel the prompt to the user).
			if tc.wantDialog && tc.returnErr == nil {
				if gotDialog.ExePath != ev.TargetExecutablePath {
					t.Errorf("dialog ExePath = %q, want %q", gotDialog.ExePath, ev.TargetExecutablePath)
				}
				if gotDialog.Signer != ev.TargetExecutableSigner {
					t.Errorf("dialog Signer = %q, want %q", gotDialog.Signer, ev.TargetExecutableSigner)
				}
				if gotDialog.Hash != ev.TargetExecutableHash {
					t.Errorf("dialog Hash = %q, want %q", gotDialog.Hash, ev.TargetExecutableHash)
				}
				if gotDialog.SubjectUser != ev.SubjectUsername {
					t.Errorf("dialog SubjectUser = %q, want %q", gotDialog.SubjectUser, ev.SubjectUsername)
				}
				if gotDialog.CommandLine != ev.CommandLine {
					t.Errorf("dialog CommandLine = %q, want %q", gotDialog.CommandLine, ev.CommandLine)
				}
				if gotDialog.TimeoutSeconds != 90 {
					t.Errorf("dialog TimeoutSeconds = %d, want 90", gotDialog.TimeoutSeconds)
				}
				if gotDialogTimeout != pamDialogTimeout {
					t.Errorf("dialog round-trip timeout = %v, want %v", gotDialogTimeout, pamDialogTimeout)
				}
			}

			// FIX 7: on the actuate path, the actuator must receive the right
			// Request — the same elevation request ID and the default timeout.
			if tc.wantActuated {
				if gotRequest.ElevationRequestID != outcome.RequestID {
					t.Errorf("actuator Request.ElevationRequestID = %q, want %q", gotRequest.ElevationRequestID, outcome.RequestID)
				}
				if gotRequest.TimeoutMs != defaultActuateTimeoutMs {
					t.Errorf("actuator Request.TimeoutMs = %d, want %d", gotRequest.TimeoutMs, defaultActuateTimeoutMs)
				}
			}
		})
	}
}

// TestActuateAndDenyMutuallyExclusive proves pamActuateMu serializes consent.exe
// actuation against dismissal: a remote actuate_elevation (actuateElevation) and
// a re-fired local deny (denyConsent) must never drive SendInput against the same
// prompt concurrently. The fake trigger/dismiss closures flip a shared `inside`
// flag on entry, sleep to widen the overlap window, and fail the test if they
// observe another invocation already inside the critical section. Run with -race.
func TestActuateAndDenyMutuallyExclusive(t *testing.T) {
	var inside atomic.Bool
	var violation atomic.Bool

	// guarded wraps a fake actuator op: assert nobody else is inside, hold the
	// section briefly to widen the race window, then clear the flag.
	guarded := func() {
		if !inside.CompareAndSwap(false, true) {
			violation.Store(true) // someone else was already inside
		}
		time.Sleep(2 * time.Millisecond)
		inside.Store(false)
	}

	swapActuatorForTest(t, func() pamactuator.Actuator {
		return fakeActuator{
			trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
				guarded()
				return pamactuator.Result{Success: true, Reason: "ok"}
			},
			dismiss: func(context.Context) pamactuator.Result {
				guarded()
				return pamactuator.Result{Success: true, Reason: "dismissed"}
			},
		}
	})
	swapElevationManagerForTest(t, func() elevaccount.AccountManager {
		return &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	})

	h := &Heartbeat{}

	const iterations = 40
	var wg sync.WaitGroup
	for i := 0; i < iterations; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.actuateElevation(context.Background(), "req-actuate", defaultActuateTimeoutMs)
		}()
		go func() {
			defer wg.Done()
			h.denyConsent(context.Background(), "req-deny", "policy_denied")
		}()
	}
	wg.Wait()

	if violation.Load() {
		t.Fatal("detected concurrent consent.exe actuation/dismissal — pamActuateMu is not serializing")
	}
}

// TestRunPamFlowSurvivesActuatorPanic proves the defer/recover at the top of
// RunPamFlow contains a syscall-level panic on the local actuate path (which
// runs on the etwlua loop goroutine, unprotected by the worker-pool recover).
// The credential-zeroing/demote defers in actuateElevation still run during
// unwinding; this is purely availability hardening.
func TestRunPamFlowSurvivesActuatorPanic(t *testing.T) {
	manager := &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func() pamactuator.Actuator {
		return fakeActuator{
			trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
				panic("simulated SendInput syscall panic")
			},
			dismiss: func(context.Context) pamactuator.Result {
				return pamactuator.Result{Success: true, Reason: "dismissed"}
			},
		}
	})

	h := &Heartbeat{}
	h.pamFindSession = func(capability, _ string) *sessionbroker.Session {
		return &sessionbroker.Session{}
	}
	h.pamRequestDialog = func(_ *sessionbroker.Session, _ string, _ ipc.PamRequestDialog, _ time.Duration) (ipc.PamDialogResult, error) {
		return ipc.PamDialogResult{Approved: true}, nil
	}

	ev := etwlua.Event{TargetExecutablePath: `C:\Windows\regedit.exe`}
	outcome := etwlua.ElevationOutcome{RequestID: "req-panic", Status: "auto_approved"}

	// Must NOT panic out of RunPamFlow.
	h.RunPamFlow(context.Background(), ev, outcome)

	// The deferred Demote in actuateElevation must still have run during unwinding.
	if manager.demoteSeen != 1 {
		t.Fatalf("Demote called %d times after panic, want 1 (deferred cleanup must run)", manager.demoteSeen)
	}
}
