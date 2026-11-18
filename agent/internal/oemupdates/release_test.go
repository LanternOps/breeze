package oemupdates

import (
	"context"
	"testing"
)

func releaseDeps(dcu *fakeDCU, store Store) Deps {
	return Deps{
		Exec:     dcu,
		Verifier: &fakeVerifier{publisher: "Dell Inc"},
		Store:    store,
		Elevated: func() bool { return true },
	}
}

func TestReleaseRestoresAndAcks(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("Takeover = %q", got)
	}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, l, releaseDeps(dcu, store))
	if r.Outcome != ReleaseRestored || r.ErrorCode != nil {
		t.Fatalf("release = %+v, want restored", r)
	}
	if !r.Acked() {
		t.Fatal("a restore must ack")
	}
	if dcu.prop("ScheduleMode") != "Auto" {
		t.Fatal("the vendor schedule was not handed back")
	}
	if err := r.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseWithNoTakeoverAcks(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, l, releaseDeps(dcu, store))
	if r.Outcome != ReleaseNothingToRestore || !r.Acked() {
		t.Fatalf("release = %+v, want nothing_to_restore, acked", r)
	}
	if len(dcu.Calls()) != 0 {
		t.Fatal("a release with nothing to restore ran the tool")
	}
}

func TestReleaseOfALaneWithoutTakeoverAcks(t *testing.T) {
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, newFakeLane(), releaseDeps(newFakeDCU(t), newMemStore()))
	if r.Outcome != ReleaseNothingToRestore || !r.Acked() {
		t.Fatalf("release = %+v", r)
	}
}

func TestReleaseVerifiesTheBinary(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	if got, _ := l.Takeover(context.Background(), dcu, store); got != TakeoverOK {
		t.Fatalf("Takeover = %q", got)
	}
	before := len(dcu.Calls())
	deps := releaseDeps(dcu, store)
	deps.Verifier = &fakeVerifier{publisher: "Someone Else"}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, l, deps)
	if r.Outcome != ReleaseFailed || r.Acked() {
		t.Fatalf("release = %+v, want failed", r)
	}
	if len(dcu.Calls()) != before {
		t.Fatal("ran a binary that failed verification")
	}
	if _, ok, _ := loadTakeoverRecord(store, LaneDell); !ok {
		t.Fatal("a failed release dropped the ownership record")
	}
}

func TestReleaseDoesNotRunBesideARun(t *testing.T) {
	l, dcu, store := takeoverLane(t), newFakeDCU(t), newMemStore()
	release, err := AcquireRunLock(store)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, l, releaseDeps(dcu, store))
	if r.Outcome != ReleaseFailed || r.ErrorCode == nil || *r.ErrorCode != "run_in_flight" {
		t.Fatalf("release = %+v, want failed run_in_flight", r)
	}
}

func TestReleaseNeedsElevation(t *testing.T) {
	deps := releaseDeps(newFakeDCU(t), newMemStore())
	deps.Elevated = func() bool { return false }
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, takeoverLane(t), deps)
	if r.Outcome != ReleaseFailed || r.ErrorCode == nil || *r.ErrorCode != "not_elevated" {
		t.Fatalf("release = %+v", r)
	}
}

func TestParseReleaseRequestIsStrict(t *testing.T) {
	if r, err := ParseReleaseRequest([]byte(`{"lane":"dell"}`)); err != nil || r.Lane != LaneDell {
		t.Fatalf("ParseReleaseRequest = %+v, %v", r, err)
	}
	for _, raw := range []string{
		`{}`, `{"lane":"Dell"}`, `{"lane":"acme"}`, `{"Lane":"dell"}`, `{"lane":"dell","lane":"hp"}`,
		`{"lane":"dell","extra":1}`, `{"lane":null}`, `{"lane":1}`, `[]`, `null`, `{"lane":"dell"} {}`,
	} {
		if _, err := ParseReleaseRequest([]byte(raw)); err == nil {
			t.Errorf("payload %s accepted", raw)
		}
	}
}
