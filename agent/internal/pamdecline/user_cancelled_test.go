package pamdecline

import (
	"encoding/json"
	"os"
	"testing"
)

// #10190 W07: Cancel request on the elevation waiting card withdraws the
// request with user_cancelled. The file must stay readable by a build that
// predates the reason (agent rollback): such a build treats an unknown
// persisted reason as a corrupt file and fences every remote apply for 24 h.
// So user_cancelled is persisted as user_denied plus an additive
// withdrawReason that older builds ignore.
func TestUserCancelledPersistsAsUserDeniedPlusWithdrawReason(t *testing.T) {
	clock := newClock()
	s, path := newFileStore(t, clock)
	if _, err := s.BeginAwaiting(reqA, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(reqA, ReasonUserCancelled); err != nil {
		t.Fatal(err)
	}
	mustRefuse(t, s, reqA, CodeUserDeclined)

	e, ok := s.entry(reqA)
	if !ok || e.Reason != ReasonUserDenied || e.WithdrawReason != ReasonUserCancelled || e.ServerReason() != ReasonUserCancelled {
		t.Fatalf("entry = %+v (server reason %q)", e, e.ServerReason())
	}
	if due := s.Due(); len(due) != 1 || due[0].ServerReason() != ReasonUserCancelled {
		t.Fatalf("due = %+v", due)
	}

	// What an older build reads: only the reasons it knows.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var old struct {
		Entries map[string]struct {
			Reason string `json:"reason"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(raw, &old); err != nil {
		t.Fatal(err)
	}
	if got := old.Entries[reqA].Reason; got != string(ReasonUserDenied) {
		t.Fatalf("persisted reason = %q, want user_denied (readable by builds without user_cancelled)", got)
	}

	// It survives a reload.
	reloaded := NewStore(path, clock.Now)
	if err := reloaded.Load(); err != nil {
		t.Fatal(err)
	}
	if e, _ := reloaded.entry(reqA); e.ServerReason() != ReasonUserCancelled {
		t.Fatalf("reloaded server reason = %q", e.ServerReason())
	}
}

func TestUnknownWithdrawReasonFallsBackToTheStoredReason(t *testing.T) {
	e := Entry{Reason: ReasonUserDenied, WithdrawReason: "from_the_future"}
	if got := e.ServerReason(); got != ReasonUserDenied {
		t.Fatalf("server reason = %q, want the stored reason", got)
	}
}
