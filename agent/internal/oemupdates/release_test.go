package oemupdates

import (
	"context"
	"testing"
)

// TestReleaseRunsNoToolAndAcks (schedule_untouched_test.go) covers the Dell
// lane, including a record an older agent's takeover left behind.

func TestReleaseOfALaneWithoutTakeoverAcks(t *testing.T) {
	exec := &fakeExec{}
	r := Release(context.Background(), ReleaseRequest{Lane: LaneDell}, newFakeLane(), Deps{Exec: exec, Store: newMemStore()})
	if r.Outcome != ReleaseNothingToRestore || !r.Acked() {
		t.Fatalf("release = %+v", r)
	}
	if len(exec.Calls()) != 0 {
		t.Fatalf("a release ran a tool: %+v", exec.Calls())
	}
}

// A release that does not name the lane it was handed is refused, not acked:
// acking it would clear the API's state for a lane nobody looked at.
func TestReleaseRefusesAMismatchedLane(t *testing.T) {
	for name, lane := range map[string]Lane{"nil lane": nil, "other lane": testDellLane(t, nil)} {
		r := Release(context.Background(), ReleaseRequest{Lane: LaneHP}, lane, Deps{})
		if r.Outcome != ReleaseFailed || r.Acked() || r.ErrorCode == nil || *r.ErrorCode != "invalid_request" {
			t.Fatalf("%s: release = %+v, want failed invalid_request", name, r)
		}
		if err := r.Validate(); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
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
