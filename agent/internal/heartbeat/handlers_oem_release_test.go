package heartbeat

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

type releaseSeams struct {
	called *oemupdates.ReleaseRequest
}

func installReleaseSeams(t *testing.T, goos string, elevated bool, answer oemupdates.ReleaseResult) *releaseSeams {
	t.Helper()
	s := &releaseSeams{}
	prevGOOS, prevElevated, prevRelease, prevDeps := oemGOOS, oemElevated, oemRelease, oemDepsFor
	oemGOOS = goos
	oemElevated = func() bool { return elevated }
	oemRelease = func(_ context.Context, req oemupdates.ReleaseRequest, _ oemupdates.Lane, _ oemupdates.Deps) oemupdates.ReleaseResult {
		s.called = &req
		return answer
	}
	oemDepsFor = func(*Heartbeat, string) oemupdates.Deps { return oemupdates.Deps{} }
	t.Cleanup(func() { oemGOOS, oemElevated, oemRelease, oemDepsFor = prevGOOS, prevElevated, prevRelease, prevDeps })
	return s
}

func decodeReleaseResult(t *testing.T, r tools.CommandResult) oemupdates.ReleaseResult {
	t.Helper()
	var out oemupdates.ReleaseResult
	dec := json.NewDecoder(strings.NewReader(r.Stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		t.Fatalf("stdout is not a release result: %v (%q)", err, r.Stdout)
	}
	if err := out.Validate(); err != nil {
		t.Fatalf("release result violates the contract: %v", err)
	}
	return out
}

func releaseCmd(payload map[string]any) Command {
	return Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRelease, Payload: payload}
}

func TestReleaseHandlerIsRegisteredAndElevated(t *testing.T) {
	if _, ok := handlerRegistry[tools.CmdOemUpdateRelease]; !ok {
		t.Fatal("oem_update_release has no handler")
	}
	if tools.CmdOemUpdateRelease != "oem_update_release" {
		t.Fatalf("command type = %q", tools.CmdOemUpdateRelease)
	}
	if !privilege.RequiresElevation(tools.CmdOemUpdateRelease) {
		t.Fatal("oem_update_release must be marked elevated")
	}
}

func TestReleaseHandlerRestoresAndAcks(t *testing.T) {
	s := installReleaseSeams(t, "windows", true, oemupdates.ReleaseResult{Lane: "dell", Outcome: oemupdates.ReleaseRestored})
	r := handleOemUpdateRelease(nil, releaseCmd(map[string]any{"lane": "dell"}))
	if r.Status != "completed" {
		t.Fatalf("status = %q (%s)", r.Status, r.Error)
	}
	if s.called == nil || s.called.Lane != "dell" {
		t.Fatalf("release ran with %+v", s.called)
	}
	if got := decodeReleaseResult(t, r); got.Outcome != oemupdates.ReleaseRestored {
		t.Fatalf("outcome = %q", got.Outcome)
	}
}

func TestReleaseHandlerWithNoTakeoverAcks(t *testing.T) {
	installReleaseSeams(t, "windows", true, oemupdates.ReleaseResult{Lane: "dell", Outcome: oemupdates.ReleaseNothingToRestore})
	r := handleOemUpdateRelease(nil, releaseCmd(map[string]any{"lane": "dell"}))
	if r.Status != "completed" {
		t.Fatalf("status = %q (%s)", r.Status, r.Error)
	}
	if got := decodeReleaseResult(t, r); got.Outcome != oemupdates.ReleaseNothingToRestore {
		t.Fatalf("outcome = %q", got.Outcome)
	}
}

func TestReleaseHandlerFailureIsFailed(t *testing.T) {
	code := "settings_import_failed"
	installReleaseSeams(t, "windows", true, oemupdates.ReleaseResult{Lane: "dell", Outcome: oemupdates.ReleaseFailed, ErrorCode: &code})
	r := handleOemUpdateRelease(nil, releaseCmd(map[string]any{"lane": "dell"}))
	if r.Status != "failed" {
		t.Fatalf("status = %q, want failed so the API releases again", r.Status)
	}
	if got := decodeReleaseResult(t, r); got.Outcome != oemupdates.ReleaseFailed || *got.ErrorCode != code {
		t.Fatalf("result = %+v", got)
	}
}

func TestReleaseHandlerRefusesABadPayload(t *testing.T) {
	s := installReleaseSeams(t, "windows", true, oemupdates.ReleaseResult{Lane: "dell", Outcome: oemupdates.ReleaseRestored})
	for _, p := range []map[string]any{{}, {"lane": "acme"}, {"lane": "dell", "extra": true}} {
		if r := handleOemUpdateRelease(nil, releaseCmd(p)); r.Status == "completed" {
			t.Fatalf("payload %v accepted", p)
		}
	}
	if s.called != nil {
		t.Fatal("a bad payload reached the release")
	}
}

func TestReleaseHandlerOffWindowsHasNothingToRestore(t *testing.T) {
	s := installReleaseSeams(t, "linux", true, oemupdates.ReleaseResult{Lane: "dell", Outcome: oemupdates.ReleaseRestored})
	r := handleOemUpdateRelease(nil, releaseCmd(map[string]any{"lane": "dell"}))
	if r.Status != "completed" || s.called != nil {
		t.Fatalf("status = %q, called = %v", r.Status, s.called)
	}
	if got := decodeReleaseResult(t, r); got.Outcome != oemupdates.ReleaseNothingToRestore {
		t.Fatalf("outcome = %q", got.Outcome)
	}
}

func TestReleaseHandlerRefusesWhenNotElevated(t *testing.T) {
	s := installReleaseSeams(t, "windows", false, oemupdates.ReleaseResult{Lane: "dell", Outcome: oemupdates.ReleaseRestored})
	r := handleOemUpdateRelease(nil, releaseCmd(map[string]any{"lane": "dell"}))
	if r.Status != "failed" || s.called != nil {
		t.Fatalf("status = %q, called = %v", r.Status, s.called)
	}
	if got := decodeReleaseResult(t, r); got.ErrorCode == nil || *got.ErrorCode != "not_elevated" {
		t.Fatalf("result = %+v", got)
	}
}

// A lane this agent does not build never took anything over. Lenovo is the
// lane no agent builds yet (Dell, Surface and HP are registered in lanes.go).
func TestReleaseHandlerUnbuiltLaneHasNothingToRestore(t *testing.T) {
	s := installReleaseSeams(t, "windows", true, oemupdates.ReleaseResult{Lane: "lenovo", Outcome: oemupdates.ReleaseRestored})
	r := handleOemUpdateRelease(nil, releaseCmd(map[string]any{"lane": "lenovo"}))
	if r.Status != "completed" || s.called != nil {
		t.Fatalf("status = %q, called = %v", r.Status, s.called)
	}
	if got := decodeReleaseResult(t, r); got.Outcome != oemupdates.ReleaseNothingToRestore {
		t.Fatalf("outcome = %q", got.Outcome)
	}
}
