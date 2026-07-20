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
		name                 string
		status               etwlua.ElevationStatus
		subjectSessionID     uint32
		wantTargetWinSession string
		dialog               ipc.PamDialogResult
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
		wantFind      bool
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
		// dismissResult, when non-nil, overrides the broker-dismiss result so the
		// deny-path logging switch can be exercised against the
		// benign "no_consent_window" and the genuine-failure reasons.
		dismissResult *ipc.PamDismissConsentResult
		// dismissErr simulates an IPC round-trip error from DismissPamConsent.
		dismissErr error
	}{
		{
			name:                 "policy hard-deny targets requester session and dismisses without dialog",
			status:               "denied",
			subjectSessionID:     7,
			wantTargetWinSession: "7",
			dialog:               approved, // ignored — denied short-circuits before the dialog
			wantFind:             true,
			wantDialog:           false,
			wantTriggered:        false,
			wantDismissed:        true,
			wantActuated:         false,
		},
		{
			name:                 "auto-approved targets valid high requester session as unsigned decimal and actuates",
			status:               "auto_approved",
			subjectSessionID:     0xFFFFFFFE,
			wantTargetWinSession: "4294967294",
			dialog:               approved,
			wantFind:             true,
			wantDialog:           true,
			wantTriggered:        true,
			wantDismissed:        false,
			wantActuated:         true,
		},
		{
			// 0xFFFFFFFF is Windows' invalid/unresolved session sentinel. Treat it
			// like zero so the broker retains its physical-console fallback.
			name:             "invalid requester session sentinel retains console fallback",
			status:           "auto_approved",
			subjectSessionID: 0xFFFFFFFF,
			dialog:           approved,
			wantFind:         true,
			wantDialog:       true,
			wantTriggered:    true,
			wantDismissed:    false,
			wantActuated:     true,
		},
		{
			// Zero is the compatibility path for old/fake/non-Windows events: the
			// empty target retains the broker's physical-console selection.
			name:          "zero requester session retains console fallback and user dismissal denies",
			status:        "auto_approved",
			dialog:        dismissed,
			wantFind:      true,
			wantDialog:    true,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:                 "pending targets requester session and user approval awaits remote",
			status:               "pending",
			subjectSessionID:     42,
			wantTargetWinSession: "42",
			dialog:               approved,
			wantFind:             true,
			wantDialog:           true,
			wantTriggered:        false,
			wantDismissed:        false,
			wantActuated:         false,
		},
		{
			name:          "pending + user-dismissed denies",
			status:        "pending",
			dialog:        dismissed,
			wantFind:      true,
			wantDialog:    true,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:                 "exact requester session without capable helper performs no PAM action",
			status:               "auto_approved",
			subjectSessionID:     44,
			wantTargetWinSession: "44",
			dialog:               approved,
			noSession:            true,
			wantFind:             true,
			wantDialog:           false, // early return precedes the dialog round-trip
			wantTriggered:        false,
			wantDismissed:        false,
			wantActuated:         false,
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
			// Session 0 cannot reach the console prompt. With no broker there is no
			// dismissal attempt and, critically, no service-local actuator fallback.
			name:          "denied with nil broker does not fall back to local dismiss",
			status:        "denied",
			dialog:        approved, // ignored
			noBroker:      true,
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			name:          "denied without capable session does not fall back to local dismiss",
			status:        "denied",
			dialog:        approved, // ignored
			noSession:     true,
			wantFind:      true,
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: false,
			wantActuated:  false,
		},
		{
			// Broker round-trip error must fail safe: even an APPROVED dialog
			// is overridden to deny+dismiss (pam_flow.go dialog-error branch).
			name:          "dialog round-trip error coerces to deny+dismiss",
			status:        "auto_approved",
			dialog:        approved, // overridden by the error path
			returnErr:     errors.New("broker pipe closed"),
			wantFind:      true,
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
			wantFind:           true,
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
			dismissResult: &ipc.PamDismissConsentResult{Success: false, Reason: "no_consent_window"},
			wantFind:      true,
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
			dismissResult: &ipc.PamDismissConsentResult{Success: false, Reason: "send_input_failed", DetailMessage: "SendInput returned zero"},
			wantFind:      true,
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
		{
			name:          "deny with dismissal IPC error does not panic",
			status:        "denied",
			dialog:        approved, // ignored
			dismissErr:    errors.New("helper pipe closed"),
			wantFind:      true,
			wantDialog:    false,
			wantTriggered: false,
			wantDismissed: true,
			wantActuated:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var triggered, localDismissed, dismissed bool
			var gotRequest pamactuator.Request
			swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
				return fakeActuator{
					trigger: func(_ context.Context, req pamactuator.Request) pamactuator.Result {
						triggered = true
						gotRequest = req
						return pamactuator.Result{Success: true, Reason: "ok"}
					},
					dismiss: func(context.Context) pamactuator.Result {
						localDismissed = true
						return pamactuator.Result{Success: true, Reason: "dismissed"}
					},
				}
			})

			manager := &fakeElevationManager{
				cred:       elevaccount.Credential{Username: "~breeze_elev", Password: "x"},
				promoteErr: tc.promoteErr,
			}
			swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

			var findCalled, dialogCalled bool
			var gotTargetWinSession string
			var gotDialog ipc.PamRequestDialog
			var gotDialogTimeout time.Duration
			var gotDialogSession, gotDismissSession *sessionbroker.Session
			var gotDismissID string
			var gotDismissTimeout time.Duration
			selectedSession := &sessionbroker.Session{SessionID: "selected-pam-helper"}
			// noBroker reproduces production wiring: all swappable seams nil
			// AND a nil sessionBroker. The defensive guard in RunPamFlow must
			// keep this from dereferencing the nil broker.
			h := &Heartbeat{}
			if !tc.noBroker {
				h.pamFindSession = func(capability, targetWinSession string) *sessionbroker.Session {
					findCalled = true
					gotTargetWinSession = targetWinSession
					if capability != ipc.ScopePam {
						t.Fatalf("FindCapableSession capability = %q, want %q", capability, ipc.ScopePam)
					}
					if tc.noSession {
						return nil
					}
					return selectedSession
				}
				h.pamRequestDialog = func(session *sessionbroker.Session, _ string, req ipc.PamRequestDialog, timeout time.Duration) (ipc.PamDialogResult, error) {
					dialogCalled = true
					gotDialogSession = session
					gotDialog = req
					gotDialogTimeout = timeout
					return tc.dialog, tc.returnErr
				}
				h.pamDismissConsent = func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
					dismissed = true
					gotDismissSession = session
					gotDismissID = id
					gotDismissTimeout = timeout
					if tc.dismissResult != nil {
						return *tc.dismissResult, tc.dismissErr
					}
					return ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}, tc.dismissErr
				}
			}

			// Distinct, recognizable field values so a transposition (e.g.
			// Signer↔Hash) in buildPamRequestDialog fails the mapping assertion.
			ev := etwlua.Event{
				SubjectUsername:        "CORP\\subjectuser",
				SubjectSessionID:       tc.subjectSessionID,
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
			if localDismissed {
				t.Error("service-local actuator Dismiss was called; Session 0 fallback is forbidden")
			}
			if findCalled != tc.wantFind {
				t.Errorf("findCalled = %v, want %v", findCalled, tc.wantFind)
			}
			if findCalled && gotTargetWinSession != tc.wantTargetWinSession {
				t.Errorf("FindCapableSession target = %q, want %q", gotTargetWinSession, tc.wantTargetWinSession)
			}

			// The dialog round-trip must only be reached when expected: denied skips
			// it after session resolution, while nil broker/session returns before
			// ask(...). With a nil broker the seam is never installed, so
			// dialogCalled stays false trivially.
			if dialogCalled != tc.wantDialog {
				t.Errorf("dialogCalled = %v, want %v", dialogCalled, tc.wantDialog)
			}
			if tc.wantDialog && gotDialogSession != selectedSession {
				t.Errorf("dialog session = %p, want selected session %p", gotDialogSession, selectedSession)
			}
			if tc.wantDismissed {
				if gotDismissSession != selectedSession {
					t.Errorf("dismiss session = %p, want exact selected session %p", gotDismissSession, selectedSession)
				}
				if gotDismissID != outcome.RequestID {
					t.Errorf("dismiss request ID = %q, want %q", gotDismissID, outcome.RequestID)
				}
				if gotDismissTimeout != pamDismissTimeout {
					t.Errorf("dismiss timeout = %v, want %v", gotDismissTimeout, pamDismissTimeout)
				}
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
			// Task 5: also the ETW-discovered target (path + command line),
			// since the local RunPamFlow path is the one caller that already
			// holds this data going into actuateElevation.
			if tc.wantActuated {
				if gotRequest.ElevationRequestID != outcome.RequestID {
					t.Errorf("actuator Request.ElevationRequestID = %q, want %q", gotRequest.ElevationRequestID, outcome.RequestID)
				}
				if gotRequest.TargetPath != ev.TargetExecutablePath {
					t.Errorf("actuator Request.TargetPath = %q, want %q", gotRequest.TargetPath, ev.TargetExecutablePath)
				}
				if gotRequest.CommandLine != ev.CommandLine {
					t.Errorf("actuator Request.CommandLine = %q, want %q", gotRequest.CommandLine, ev.CommandLine)
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
// prompt concurrently. The fake trigger/broker-dismiss closures flip a shared
// `inside` flag on entry, sleep to widen the overlap window, and fail the test
// if they observe another invocation already inside the critical section. Run
// with -race.
func TestActuateAndDenyMutuallyExclusive(t *testing.T) {
	var inside atomic.Bool
	var violation atomic.Bool
	var localDismissed atomic.Bool

	// guarded wraps an actuation or broker-dismiss op: assert nobody else is
	// inside, hold the section briefly to widen the race window, then clear it.
	guarded := func() {
		if !inside.CompareAndSwap(false, true) {
			violation.Store(true) // someone else was already inside
		}
		time.Sleep(2 * time.Millisecond)
		inside.Store(false)
	}

	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{
			trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
				guarded()
				return pamactuator.Result{Success: true, Reason: "ok"}
			},
			dismiss: func(context.Context) pamactuator.Result {
				localDismissed.Store(true)
				return pamactuator.Result{}
			},
		}
	})
	swapElevationManagerForTest(t, func() elevaccount.AccountManager {
		return &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	})

	selectedSession := &sessionbroker.Session{SessionID: "selected-pam-helper"}
	h := &Heartbeat{
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			if session != selectedSession {
				t.Errorf("dismiss session = %p, want selected session %p", session, selectedSession)
			}
			if id != "req-deny" {
				t.Errorf("dismiss request ID = %q, want req-deny", id)
			}
			if timeout != pamDismissTimeout {
				t.Errorf("dismiss timeout = %v, want %v", timeout, pamDismissTimeout)
			}
			guarded()
			return ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}, nil
		},
	}

	const iterations = 40
	var wg sync.WaitGroup
	for i := 0; i < iterations; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			h.actuateElevation(context.Background(), "req-actuate", defaultActuateTimeoutMs, pamTarget{})
		}()
		go func() {
			defer wg.Done()
			h.denyConsent(selectedSession, "req-deny", "policy_denied", "")
		}()
	}
	wg.Wait()

	if violation.Load() {
		t.Fatal("detected concurrent consent.exe actuation/dismissal — pamActuateMu is not serializing")
	}
	if localDismissed.Load() {
		t.Fatal("service-local actuator Dismiss was called; Session 0 fallback is forbidden")
	}
}

func TestDenyConsentTimeoutKeepsGateUntilHelperQuiescent(t *testing.T) {
	quiesced := make(chan sessionbroker.PamDismissOutcome, 1)
	selectedSession := &sessionbroker.Session{SessionID: "selected-pam-helper"}
	manager := &fakeElevationManager{promoteErr: errors.New("simulated promote failure")}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	var dismissCalls atomic.Int32
	h := &Heartbeat{
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			dismissCalls.Add(1)
			return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
				Cause:    sessionbroker.ErrCommandTimeout,
				Quiesced: quiesced,
			}
		},
	}

	h.denyConsent(selectedSession, "req-timeout", "policy_denied", "")

	resultCh := make(chan pamactuator.Result, 1)
	go func() {
		resultCh <- h.actuateElevation(context.Background(), "req-after-timeout", defaultActuateTimeoutMs, pamTarget{})
	}()
	select {
	case result := <-resultCh:
		if result.Reason != "dismissal_uncertain" {
			t.Fatalf("actuation reason = %q, want dismissal_uncertain", result.Reason)
		}
	case <-time.After(250 * time.Millisecond):
		close(quiesced)
		t.Fatal("fail-closed actuation check blocked instead of returning promptly")
	}
	if manager.promoteSeen != 0 {
		t.Fatalf("Promote calls while dismissal uncertain = %d, want 0", manager.promoteSeen)
	}
	h.denyConsent(selectedSession, "req-second-deny", "policy_denied", "")
	if got := dismissCalls.Load(); got != 1 {
		t.Fatalf("dismiss calls while previous completion uncertain = %d, want 1", got)
	}

	// Only a PROVEN-SUCCESSFUL dismissal reopens the gate.
	quiesced <- sessionbroker.PamDismissOutcome{
		Proven: true,
		Result: ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"},
	}
	close(quiesced)
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.pamActuateMu.Lock()
		uncertain := h.pamDismissalUncertain
		h.pamActuateMu.Unlock()
		if !uncertain {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("PAM actuation gate stayed fail-closed after helper quiescence")
		}
		time.Sleep(time.Millisecond)
	}

	result := h.actuateElevation(context.Background(), "req-after-quiescence", defaultActuateTimeoutMs, pamTarget{})
	if result.Reason == "dismissal_uncertain" {
		t.Fatal("actuation remained fail-closed after helper quiescence")
	}
	if manager.promoteSeen != 1 {
		t.Fatalf("Promote calls after helper quiescence = %d, want 1", manager.promoteSeen)
	}
}

// TestRunPamFlowDismissPanicUnlocksPamActuateMutex proves the dismissal critical
// section uses a deferred unlock. RunPamFlow contains the injected panic, after
// which the mutex must remain usable by later actuation/dismissal work.
func TestRunPamFlowDismissPanicUnlocksPamActuateMutex(t *testing.T) {
	selectedSession := &sessionbroker.Session{SessionID: "selected-pam-helper"}
	h := &Heartbeat{
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			return selectedSession
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			panic("simulated broker-dismiss seam panic")
		},
	}

	h.RunPamFlow(context.Background(), etwlua.Event{}, etwlua.ElevationOutcome{
		RequestID: "req-dismiss-panic",
		Status:    etwlua.ElevationDenied,
	})

	if !h.pamActuateMu.TryLock() {
		t.Fatal("pamActuateMu remained locked after broker-dismiss seam panic")
	}
	h.pamActuateMu.Unlock()
}

// TestRunPamFlowSurvivesActuatorPanic proves the defer/recover at the top of
// RunPamFlow contains a syscall-level panic on the local actuate path (which
// runs on the etwlua loop goroutine, unprotected by the worker-pool recover).
// The credential-zeroing/demote defers in actuateElevation still run during
// unwinding; this is purely availability hardening.
func TestRunPamFlowSurvivesActuatorPanic(t *testing.T) {
	manager := &fakeElevationManager{cred: elevaccount.Credential{Username: "~breeze_elev", Password: "x"}}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
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

// gateClosed reports whether PAM actuation is currently fail-closed.
func gateClosed(h *Heartbeat) bool {
	h.pamActuateMu.Lock()
	defer h.pamActuateMu.Unlock()
	return h.pamDismissalUncertain
}

// waitForGate polls until the gate reaches want, or fails the test.
func waitForGate(t *testing.T, h *Heartbeat, want bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if gateClosed(h) == want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("%s (gate closed = %v, want %v)", msg, gateClosed(h), want)
}

// TestDenyConsentProvenFailedDismissalKeepsGateClosed covers issue #2610
// Critical 1: a LATE helper response that definitively reports the dismissal
// FAILED must not reopen PAM actuation. The old gate closed on "a correlated
// response arrived" (execution finished), which let the next approved
// actuation type freshly-promoted admin credentials into a still-live,
// previously-DENIED consent.exe window — silently reversing the deny.
func TestDenyConsentProvenFailedDismissalKeepsGateClosed(t *testing.T) {
	failureReasons := []string{"consent_did_not_close", "send_input_failed", "desktop_open_failed"}
	for _, reason := range failureReasons {
		t.Run(reason, func(t *testing.T) {
			quiesced := make(chan sessionbroker.PamDismissOutcome, 1)
			// Proven: the helper finished and answered. But it answered "I did
			// NOT close the prompt" — the denied window is still on screen.
			quiesced <- sessionbroker.PamDismissOutcome{
				Proven: true,
				Result: ipc.PamDismissConsentResult{Success: false, Reason: reason},
			}
			close(quiesced)

			manager := &fakeElevationManager{}
			swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

			var recoveryProbes atomic.Int32
			h := &Heartbeat{
				pamRecoveryDelay:       time.Millisecond,
				pamRecoveryMaxAttempts: 3,
				// No helper is findable, so recovery can never prove the
				// desktop is clear and the gate must stay closed throughout.
				pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
					recoveryProbes.Add(1)
					return nil
				},
				pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
					return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
						Cause:    sessionbroker.ErrCommandTimeout,
						Quiesced: quiesced,
					}
				},
			}

			h.denyConsent(&sessionbroker.Session{SessionID: "helper"}, "req-denied", "policy_denied", "")

			// Give the quiescence goroutine time to (wrongly) release the gate.
			time.Sleep(50 * time.Millisecond)
			if !gateClosed(h) {
				t.Fatal("gate released on a CONFIRMED-FAILED dismissal — a live denied consent.exe can now be credentialed")
			}

			res := h.actuateElevation(context.Background(), "req-next", defaultActuateTimeoutMs, pamTarget{})
			if res.Reason != "dismissal_uncertain" {
				t.Fatalf("actuation reason = %q, want dismissal_uncertain", res.Reason)
			}
			if manager.promoteSeen != 0 {
				t.Fatalf("Promote calls after a failed dismissal = %d, want 0 (credentials must never be promoted)", manager.promoteSeen)
			}
			// Recovery must actually have been attempted — otherwise this test
			// would pass on a build that simply never recovers.
			if recoveryProbes.Load() == 0 {
				t.Fatal("recovery was never attempted after a confirmed-failed dismissal")
			}
		})
	}
}

// TestDenyConsentHelperDeathRecoversViaProof covers issue #2610 Critical 2: if
// the helper session dies mid-dismiss, the gate must not strand PAM for the
// agent's whole lifetime. Recovery re-establishes PROOF (a fresh helper
// reporting no_consent_window) rather than timing out into an open state.
func TestDenyConsentHelperDeathRecoversViaProof(t *testing.T) {
	quiesced := make(chan sessionbroker.PamDismissOutcome, 1)
	// Helper died: no correlated response ever arrived.
	quiesced <- sessionbroker.PamDismissOutcome{Proven: false}
	close(quiesced)

	manager := &fakeElevationManager{}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })
	swapActuatorForTest(t, func(pamactuator.Strategy) pamactuator.Actuator {
		return fakeActuator{
			trigger: func(context.Context, pamactuator.Request) pamactuator.Result {
				return pamactuator.Result{Success: true, Reason: "actuated"}
			},
		}
	})

	reconnected := &sessionbroker.Session{SessionID: "reconnected-helper"}
	// The helper stays "down" until the test opens this barrier, so the
	// gate-engaged assertion below cannot race a fast recovery release.
	allowReconnect := make(chan struct{})
	var findCalls atomic.Int32
	var firstDismissDone atomic.Bool
	h := &Heartbeat{
		pamRecoveryDelay:       2 * time.Millisecond,
		pamRecoveryMaxAttempts: 200,
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			findCalls.Add(1)
			select {
			case <-allowReconnect:
				return reconnected
			default:
				return nil // helper still down
			}
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			if !firstDismissDone.Swap(true) {
				return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
					Cause:    sessionbroker.ErrCommandTimeout,
					Quiesced: quiesced,
				}
			}
			// Recovery probe on the reconnected helper: it looked at the
			// desktop and there is no consent window left. That is proof.
			return ipc.PamDismissConsentResult{Success: false, Reason: "no_consent_window"}, nil
		},
	}

	h.denyConsent(&sessionbroker.Session{SessionID: "dying-helper"}, "req-death", "policy_denied", "2")

	// Safe to assert unconditionally: recovery cannot prove anything until the
	// barrier opens, so the gate is deterministically still closed here.
	if !gateClosed(h) {
		t.Fatal("gate must engage when the helper dies with the dismissal unproven")
	}
	close(allowReconnect)
	waitForGate(t, h, false, "PAM stayed permanently locked out after helper death — recovery never re-established proof")

	res := h.actuateElevation(context.Background(), "req-after-recovery", defaultActuateTimeoutMs, pamTarget{})
	if res.Reason == "dismissal_uncertain" {
		t.Fatal("actuation still fail-closed after recovery proved the consent desktop is clear")
	}
}

// TestPamGateRecoveryExhaustionStaysFailClosed pins the safety direction of the
// recovery bound: when recovery never obtains proof, PAM stays DISABLED. The
// attempt cap bounds probing, not the fail-closed guarantee — timing out into
// an open state would reintroduce Critical 1.
func TestPamGateRecoveryExhaustionStaysFailClosed(t *testing.T) {
	quiesced := make(chan sessionbroker.PamDismissOutcome, 1)
	quiesced <- sessionbroker.PamDismissOutcome{Proven: false}
	close(quiesced)

	manager := &fakeElevationManager{}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	stillLive := &sessionbroker.Session{SessionID: "helper-with-stuck-prompt"}
	var firstDismissDone atomic.Bool
	var probes atomic.Int32
	var idMu sync.Mutex
	seenIDs := map[string]int{}
	stuckStop := make(chan struct{})
	t.Cleanup(func() { close(stuckStop) })
	h := &Heartbeat{
		stopChan:               stuckStop, // lets reassertStuckPamGate exit with the test
		pamRecoveryDelay:       time.Millisecond,
		pamRecoveryMaxAttempts: 4,
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			return stillLive
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			if !firstDismissDone.Swap(true) {
				return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
					Cause:    sessionbroker.ErrCommandTimeout,
					Quiesced: quiesced,
				}
			}
			idMu.Lock()
			seenIDs[id]++
			idMu.Unlock()
			probes.Add(1)
			// Every recovery probe still finds the denied prompt on screen.
			return ipc.PamDismissConsentResult{Success: false, Reason: "consent_did_not_close"}, nil
		},
	}

	h.denyConsent(stillLive, "req-stuck", "policy_denied", "")

	// Let recovery run to exhaustion.
	deadline := time.Now().Add(2 * time.Second)
	for probes.Load() < 4 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)

	if got := probes.Load(); got != 4 {
		t.Fatalf("recovery probes = %d, want 4 (bounded retry)", got)
	}
	// Each probe must carry its own IPC correlation ID: reusing the original
	// one collides with a pending registration left by an earlier uncertain
	// probe (ErrDuplicateCommand) and silently neuters recovery.
	idMu.Lock()
	defer idMu.Unlock()
	if len(seenIDs) != 4 {
		t.Fatalf("distinct recovery command IDs = %d, want 4 (IDs: %v)", len(seenIDs), seenIDs)
	}
	for id := range seenIDs {
		if id == "req-stuck" {
			t.Fatal("recovery probe reused the original elevation request ID")
		}
	}
	if !gateClosed(h) {
		t.Fatal("gate opened after recovery exhaustion — recovery must never time out into an OPEN state")
	}
	res := h.actuateElevation(context.Background(), "req-post-exhaustion", defaultActuateTimeoutMs, pamTarget{})
	if res.Reason != "dismissal_uncertain" {
		t.Fatalf("actuation reason = %q, want dismissal_uncertain", res.Reason)
	}
}

// TestPamDismissOutcomeCleared pins the single predicate that reopens PAM.
func TestPamDismissOutcomeCleared(t *testing.T) {
	cases := []struct {
		name    string
		outcome sessionbroker.PamDismissOutcome
		want    bool
	}{
		{"proven success", sessionbroker.PamDismissOutcome{Proven: true, Result: ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}}, true},
		{"proven no consent window", sessionbroker.PamDismissOutcome{Proven: true, Result: ipc.PamDismissConsentResult{Reason: "no_consent_window"}}, true},
		{"proven failure", sessionbroker.PamDismissOutcome{Proven: true, Result: ipc.PamDismissConsentResult{Reason: "consent_did_not_close"}}, false},
		{"proven but undecodable", sessionbroker.PamDismissOutcome{Proven: true, Err: errors.New("decode failed"), Result: ipc.PamDismissConsentResult{Success: true}}, false},
		{"unproven helper death", sessionbroker.PamDismissOutcome{Proven: false}, false},
		{"unproven despite success payload", sessionbroker.PamDismissOutcome{Proven: false, Result: ipc.PamDismissConsentResult{Success: true}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.outcome.Cleared(); got != tc.want {
				t.Fatalf("Cleared() = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestDenyConsentSilentHelperReachesRecovery covers the half of #2610's
// permanent-lockout bug that survived the first fix: quiesced is only closed
// when a correlated response arrives OR the session tears down, so a helper
// that HANGS while its IPC session stays connected — exactly what produces the
// ErrCommandTimeout that opens the gate — never yields an outcome at all.
// Without a bounded proof wait the gate goroutine parks forever, recovery never
// runs, and PAM is dead until restart.
func TestDenyConsentSilentHelperReachesRecovery(t *testing.T) {
	// Never written to, never closed — the hung-helper case.
	silent := make(chan sessionbroker.PamDismissOutcome)

	manager := &fakeElevationManager{}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	recovered := &sessionbroker.Session{SessionID: "recovered-helper"}
	var firstDismissDone atomic.Bool
	var probes atomic.Int32
	h := &Heartbeat{
		pamGateProofTimeout:    5 * time.Millisecond,
		pamRecoveryDelay:       2 * time.Millisecond,
		pamRecoveryMaxAttempts: 10,
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			return recovered
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			if !firstDismissDone.Swap(true) {
				return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
					Cause:    sessionbroker.ErrCommandTimeout,
					Quiesced: silent,
				}
			}
			probes.Add(1)
			return ipc.PamDismissConsentResult{Reason: pamactuator.ReasonNoConsentWindow}, nil
		},
	}

	h.denyConsent(recovered, "req-silent", "policy_denied", "")

	if !gateClosed(h) {
		t.Fatal("gate must engage when the dismissal cannot be proven")
	}
	waitForGate(t, h, false, "silent helper stranded PAM — bounded proof wait never fell through to recovery")
	if probes.Load() == 0 {
		t.Fatal("recovery never probed; the gate goroutine was still parked on the silent channel")
	}
}

// TestDenyConsentNilQuiescenceReachesRecovery pins the defensive branch: a
// PamDismissUncertainError carrying a nil Quiesced must engage the gate and
// reach recovery. Receiving from a nil channel blocks forever, so without the
// bounded wait this deadlocks with PAM permanently disabled and no further log.
func TestDenyConsentNilQuiescenceReachesRecovery(t *testing.T) {
	manager := &fakeElevationManager{}
	swapElevationManagerForTest(t, func() elevaccount.AccountManager { return manager })

	helper := &sessionbroker.Session{SessionID: "helper"}
	var firstDismissDone atomic.Bool
	var probes atomic.Int32
	h := &Heartbeat{
		pamGateProofTimeout:    5 * time.Millisecond,
		pamRecoveryDelay:       2 * time.Millisecond,
		pamRecoveryMaxAttempts: 10,
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			return helper
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			if !firstDismissDone.Swap(true) {
				return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
					Cause:    sessionbroker.ErrCommandTimeout,
					Quiesced: nil,
				}
			}
			probes.Add(1)
			return ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}, nil
		},
	}

	h.denyConsent(helper, "req-nil-chan", "policy_denied", "")

	if !gateClosed(h) {
		t.Fatal("a nil quiescence channel must still engage the fail-closed gate")
	}
	waitForGate(t, h, false, "nil quiescence channel deadlocked the gate instead of reaching recovery")
	if probes.Load() == 0 {
		t.Fatal("recovery never probed after a nil quiescence channel")
	}
}

// TestPamGateRecoveryStopsOnShutdown proves recovery abandons cleanly on agent
// shutdown rather than spinning, and leaves the gate CLOSED.
func TestPamGateRecoveryStopsOnShutdown(t *testing.T) {
	stop := make(chan struct{})
	silent := make(chan sessionbroker.PamDismissOutcome)

	h := &Heartbeat{
		stopChan:               stop,
		pamGateProofTimeout:    time.Hour, // force the stopChan branch of the proof wait
		pamRecoveryDelay:       time.Hour,
		pamRecoveryMaxAttempts: 10,
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			return &sessionbroker.Session{SessionID: "helper"}
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
				Cause:    sessionbroker.ErrCommandTimeout,
				Quiesced: silent,
			}
		},
	}

	h.denyConsent(&sessionbroker.Session{SessionID: "helper"}, "req-shutdown", "policy_denied", "")
	if !gateClosed(h) {
		t.Fatal("gate must engage before shutdown")
	}
	close(stop)

	// The gate must remain closed — shutdown is not proof of anything.
	time.Sleep(20 * time.Millisecond)
	if !gateClosed(h) {
		t.Fatal("gate released on shutdown; shutdown proves nothing about the consent desktop")
	}
}

// TestRunPamFlowPassesRequesterSessionToDeny pins the targetWinSession wiring
// that recovery depends on. If RunPamFlow stopped forwarding the requester's
// Windows session, recovery would probe (and Escape prompts on) the console
// fallback desktop instead of the requester's.
func TestRunPamFlowPassesRequesterSessionToDeny(t *testing.T) {
	cases := []struct {
		name             string
		subjectSessionID uint32
		wantTarget       string
	}{
		{"resolved requester session", 3, "3"},
		{"zero is unresolved", 0, ""},
		{"windows invalid-session sentinel", 0xFFFFFFFF, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var findTargets []string
			var mu sync.Mutex
			h := &Heartbeat{
				pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
					mu.Lock()
					findTargets = append(findTargets, targetWinSession)
					mu.Unlock()
					return &sessionbroker.Session{SessionID: "helper"}
				},
				pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
					return ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"}, nil
				},
			}

			h.RunPamFlow(context.Background(),
				etwlua.Event{SubjectSessionID: tc.subjectSessionID},
				etwlua.ElevationOutcome{Status: etwlua.ElevationDenied, RequestID: "req-wiring"})

			mu.Lock()
			defer mu.Unlock()
			if len(findTargets) == 0 {
				t.Fatal("RunPamFlow never located a helper session")
			}
			if findTargets[0] != tc.wantTarget {
				t.Fatalf("targetWinSession = %q, want %q", findTargets[0], tc.wantTarget)
			}
		})
	}
}

// TestReassertStuckPamGateKeepsWarning covers the durability half of #2610:
// the terminal "PAM disabled" state must stay visible, not be logged once and
// then go silent for the rest of the agent's life.
func TestReassertStuckPamGateKeepsWarning(t *testing.T) {
	t.Run("re-announces while the gate stays stuck", func(t *testing.T) {
		stop := make(chan struct{})
		defer close(stop)
		h := &Heartbeat{
			stopChan:                     stop,
			pamGateStuckReassertInterval: time.Millisecond,
			pamDismissalUncertain:        true,
		}

		done := make(chan struct{})
		go func() { h.reassertStuckPamGate("req-stuck"); close(done) }()

		// It must still be running (i.e. still re-asserting) after several
		// intervals rather than having returned after a single announcement.
		select {
		case <-done:
			t.Fatal("reassert loop exited while the gate was still stuck")
		case <-time.After(25 * time.Millisecond):
		}
	})

	t.Run("exits once the gate clears", func(t *testing.T) {
		stop := make(chan struct{})
		defer close(stop)
		h := &Heartbeat{
			stopChan:                     stop,
			pamGateStuckReassertInterval: time.Millisecond,
			pamDismissalUncertain:        true,
		}

		done := make(chan struct{})
		go func() { h.reassertStuckPamGate("req-stuck"); close(done) }()

		h.pamActuateMu.Lock()
		h.pamDismissalUncertain = false
		h.pamActuateMu.Unlock()

		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("reassert loop kept running after the gate cleared")
		}
	})

	t.Run("exits on shutdown", func(t *testing.T) {
		stop := make(chan struct{})
		h := &Heartbeat{
			stopChan:                     stop,
			pamGateStuckReassertInterval: time.Hour,
			pamDismissalUncertain:        true,
		}

		done := make(chan struct{})
		go func() { h.reassertStuckPamGate("req-stuck"); close(done) }()
		close(stop)

		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatal("reassert loop did not exit on agent shutdown")
		}
	})
}

// TestRecoveryDrainsLateProof pins that a helper which answers AFTER the proof
// timeout still gets its answer honored: recovery drains the late outcome
// instead of exhausting while real evidence sits unread in the buffer.
func TestRecoveryDrainsLateProof(t *testing.T) {
	quiesced := make(chan sessionbroker.PamDismissOutcome, 1)

	stop := make(chan struct{})
	defer close(stop)
	var probes atomic.Int32
	var firstDismissDone atomic.Bool
	h := &Heartbeat{
		stopChan:               stop,
		pamGateProofTimeout:    2 * time.Millisecond,
		pamRecoveryDelay:       5 * time.Millisecond,
		pamRecoveryMaxAttempts: 50,
		// No helper is reachable, so the ONLY way the gate can open is by
		// draining the late proof.
		pamFindSession: func(capability, targetWinSession string) *sessionbroker.Session {
			probes.Add(1)
			return nil
		},
		pamDismissConsent: func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
			if !firstDismissDone.Swap(true) {
				return ipc.PamDismissConsentResult{}, &sessionbroker.PamDismissUncertainError{
					Cause:    sessionbroker.ErrCommandTimeout,
					Quiesced: quiesced,
				}
			}
			return ipc.PamDismissConsentResult{}, errors.New("no helper")
		},
	}

	h.denyConsent(&sessionbroker.Session{SessionID: "slow-helper"}, "req-late", "policy_denied", "")
	if !gateClosed(h) {
		t.Fatal("gate must engage while the dismissal is unproven")
	}

	// The helper finally answers, well after the proof window closed.
	quiesced <- sessionbroker.PamDismissOutcome{
		Proven: true,
		Result: ipc.PamDismissConsentResult{Success: true, Reason: "dismissed"},
	}
	close(quiesced)

	waitForGate(t, h, false, "recovery ignored a late but valid dismissal proof")
}
