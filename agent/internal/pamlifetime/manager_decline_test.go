package pamlifetime

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/pamdecline"
)

// #8971: the lifetime manager refuses an apply for a request the end user
// declined (or whose decision record cannot be trusted) before it pins the
// target, prepares a ledger entry, promotes the account or hands off a
// received observation. A declined request leaves only a failed result.

type fakeDeclineChecker map[string]string

func (f fakeDeclineChecker) Check(requestID string) (bool, string) {
	code, ok := f[requestID]
	return ok, code
}

func newDeclineTestManager(t *testing.T, checker DeclineChecker) (*lifecycleManager, *fakeWindowsPrimitives, *[]string) {
	t.Helper()
	var order []string
	windows := &fakeWindowsPrimitives{order: &order}
	m := newLifecycleManager(NewStore(filepath.Join(t.TempDir(), "ledger.json")), windows, &fakeAccountLifecycle{order: &order}, nil)
	m.SetDeclineChecker(checker)
	return m, windows, &order
}

func assertRefusedBeforeAnyWork(t *testing.T, m *lifecycleManager, windows *fakeWindowsPrimitives, order *[]string, wantCode string) {
	t.Helper()
	handoffCalled := false
	res := m.ApplyWithReceivedObservation(context.Background(), validApply(1), func(Result) error {
		handoffCalled = true
		return nil
	})
	if res.State != ResultFailed || res.FailureCode != wantCode {
		t.Fatalf("result = %+v, want failed/%s", res, wantCode)
	}
	if res.ActuationID != testActuationID || res.Generation != 1 {
		t.Fatalf("result identity = %s/%d, want the command's own", res.ActuationID, res.Generation)
	}
	if res.Evidence.BootID == "" || res.Evidence.BootID == "windows-boot-unavailable" {
		t.Fatalf("result boot id = %q, want the real boot id", res.Evidence.BootID)
	}
	if windows.pinTarget {
		t.Error("target was pinned for a refused request")
	}
	if handoffCalled {
		t.Error("received observation handed off for a refused request")
	}
	if len(*order) != 0 {
		t.Errorf("account/process work ran for a refused request: %v", *order)
	}
	if _, ok := m.store.Entry(testActuationID); ok {
		t.Error("ledger entry prepared for a refused request")
	}
}

func TestApplyRefusesDeclinedRequest(t *testing.T) {
	m, windows, order := newDeclineTestManager(t, fakeDeclineChecker{testRequestID: pamdecline.CodeUserDeclined})
	assertRefusedBeforeAnyWork(t, m, windows, order, pamdecline.CodeUserDeclined)
}

func TestApplyRefusesWhenDeclineRecordUntrusted(t *testing.T) {
	m, windows, order := newDeclineTestManager(t, fakeDeclineChecker{testRequestID: pamdecline.CodeDeclineRecordUntrusted})
	assertRefusedBeforeAnyWork(t, m, windows, order, pamdecline.CodeDeclineRecordUntrusted)
}

func TestApplyRefusesUndecidedRequest(t *testing.T) {
	m, windows, order := newDeclineTestManager(t, fakeDeclineChecker{testRequestID: pamdecline.CodeUserDecisionPending})
	assertRefusedBeforeAnyWork(t, m, windows, order, pamdecline.CodeUserDecisionPending)
}

func TestApplyUnaffectedForOtherRequest(t *testing.T) {
	m, windows, _ := newDeclineTestManager(t, fakeDeclineChecker{"99999999-0000-4000-8000-000000000009": pamdecline.CodeUserDeclined})
	res := m.Apply(context.Background(), validApply(1))
	if res.FailureCode == pamdecline.CodeUserDeclined {
		t.Fatalf("another request's decline refused this apply: %+v", res)
	}
	if !windows.pinTarget {
		t.Fatal("apply for an undeclined request never reached PinTarget")
	}
}

func TestApplyRefusesDeclinedAfterRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pam-declined-requests.json")
	before := pamdecline.NewStore(path, nil)
	if err := before.Load(); err != nil {
		t.Fatal(err)
	}
	if _, err := before.BeginAwaiting(testRequestID, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := before.Decline(testRequestID, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}

	// New process: a fresh store loaded from disk and a fresh manager.
	after := pamdecline.NewStore(path, nil)
	if err := after.Load(); err != nil {
		t.Fatal(err)
	}
	m, windows, order := newDeclineTestManager(t, after)
	assertRefusedBeforeAnyWork(t, m, windows, order, pamdecline.CodeUserDeclined)
}

func TestApplyWithNilDeclineCheckerProceeds(t *testing.T) {
	m, windows, _ := newDeclineTestManager(t, nil)
	_ = m.Apply(context.Background(), validApply(1))
	if !windows.pinTarget {
		t.Fatal("a nil checker must not refuse")
	}
}
