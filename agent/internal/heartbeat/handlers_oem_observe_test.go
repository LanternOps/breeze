package heartbeat

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/oemupdates/observe"
	"github.com/breeze-rmm/agent/internal/privilege"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

type observeSeams struct {
	collected   int
	req         observe.Request
	version     string
	deadline    time.Duration
	hasDeadline bool
	result      func(observe.Request) observe.Result
}

// installObserveSeams fakes the collector and fails the test if the handler
// reaches any of oem_update_run's seams: deps, store, runner or release.
func installObserveSeams(t *testing.T, goos string, elevated bool) *observeSeams {
	t.Helper()
	s := &observeSeams{}
	prevGOOS, prevElevated, prevCollect, prevHost := oemGOOS, oemElevated, oemObserveCollect, oemObserveHost
	prevRun, prevDeps, prevStore, prevRelease := oemRun, oemDepsFor, oemStore, oemRelease
	oemGOOS = goos
	oemElevated = func() bool { return elevated }
	oemObserveHost = func() observe.Host { return observe.Host{} }
	oemObserveCollect = func(ctx context.Context, _ observe.Host, req observe.Request, version string) observe.Result {
		s.collected++
		s.req, s.version = req, version
		if d, ok := ctx.Deadline(); ok {
			s.hasDeadline, s.deadline = true, time.Until(d)
		}
		if s.result != nil {
			return s.result(req)
		}
		return observe.Collect(ctx, observe.Host{}, req, version)
	}
	oemRun = func(context.Context, oemupdates.RunRequest, oemupdates.Lane, oemupdates.Deps) oemupdates.RunResult {
		t.Fatal("oem_observe reached the vendor update runner")
		return oemupdates.RunResult{}
	}
	oemDepsFor = func(*Heartbeat, string) oemupdates.Deps {
		t.Fatal("oem_observe built vendor update deps")
		return oemupdates.Deps{}
	}
	oemStore = func() oemupdates.Store {
		t.Fatal("oem_observe opened the vendor update store")
		return nil
	}
	oemRelease = func(context.Context, oemupdates.ReleaseRequest, oemupdates.Lane, oemupdates.Deps) oemupdates.ReleaseResult {
		t.Fatal("oem_observe reached the release path")
		return oemupdates.ReleaseResult{}
	}
	t.Cleanup(func() {
		oemGOOS, oemElevated, oemObserveCollect, oemObserveHost = prevGOOS, prevElevated, prevCollect, prevHost
		oemRun, oemDepsFor, oemStore, oemRelease = prevRun, prevDeps, prevStore, prevRelease
	})
	return s
}

func observePayload(mutate func(map[string]any)) map[string]any {
	p := map[string]any{
		"lane":                 "lenovo",
		"observeLevel":         "passive",
		"escrowedProtectorIds": []any{"3c6c3b5e-0d1e-4a3e-9d0a-6f2f8c1b2a11"},
	}
	if mutate != nil {
		mutate(p)
	}
	return p
}

func runObserve(payload map[string]any) tools.CommandResult {
	return handleOemObserve(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemObserve, Payload: payload})
}

func TestOemObserveRegistered(t *testing.T) {
	if tools.CmdOemObserve != "oem_observe" {
		t.Fatalf("command type = %q", tools.CmdOemObserve)
	}
	if _, ok := handlerRegistry[tools.CmdOemObserve]; !ok {
		t.Fatal("oem_observe has no handler")
	}
	if !privilege.RequiresElevation(tools.CmdOemObserve) {
		t.Fatal("oem_observe must be listed as needing elevation")
	}
	if _, ok := interruptedResultBodies[tools.CmdOemObserve]; ok {
		t.Fatal("oem_observe keeps no durable record, so it has no interrupted body")
	}
}

func TestOemObserveSuccessPutsResultOnStdout(t *testing.T) {
	s := installObserveSeams(t, "windows", true)
	r := runObserve(observePayload(nil))
	if r.Status != "completed" || r.ExitCode != 0 || r.Error != "" {
		t.Fatalf("result = %+v", r)
	}
	if s.collected != 1 || s.req.Lane != observe.LaneLenovo || len(s.req.EscrowedProtectorIDs) != 1 {
		t.Fatalf("collector saw %+v (%d calls)", s.req, s.collected)
	}
	if !s.hasDeadline || s.deadline <= 0 || s.deadline > oemObserveTimeout {
		t.Fatalf("collector context deadline = %v (set %v), want within %v", s.deadline, s.hasDeadline, oemObserveTimeout)
	}
	var out observe.Result
	dec := json.NewDecoder(strings.NewReader(r.Stdout))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&out); err != nil {
		t.Fatalf("stdout is not an observe result: %v (%q)", err, r.Stdout)
	}
	if err := out.Validate(); err != nil {
		t.Fatalf("stdout fails the contract: %v", err)
	}
	if out.Lane != observe.LaneLenovo || out.AgentVersion == "" {
		t.Fatalf("result lane %q agentVersion %q", out.Lane, out.AgentVersion)
	}
}

func TestOemObservePassesAgentVersion(t *testing.T) {
	s := installObserveSeams(t, "windows", true)
	h := &Heartbeat{agentVersion: "0.131.0"}
	r := handleOemObserve(h, Command{ID: oemTestCmdID, Type: tools.CmdOemObserve, Payload: observePayload(nil)})
	if r.Status != "completed" || s.version != "0.131.0" {
		t.Fatalf("status %q version %q", r.Status, s.version)
	}
}

func TestOemObserveRefusals(t *testing.T) {
	cases := map[string]struct {
		goos     string
		elevated bool
		mutate   func(map[string]any)
		code     string
	}{
		"malformed payload":       {"windows", true, func(p map[string]any) { p["extra"] = true }, "invalid_payload"},
		"missing ids":             {"windows", true, func(p map[string]any) { delete(p, "escrowedProtectorIds") }, "invalid_payload"},
		"scan level refused":      {"windows", true, func(p map[string]any) { p["observeLevel"] = "scan" }, "invalid_payload"},
		"dell lane":               {"windows", true, func(p map[string]any) { p["lane"] = "dell" }, "invalid_payload"},
		"not windows":             {"linux", true, nil, "os_not_supported"},
		"not elevated":            {"windows", false, nil, "not_elevated"},
		"bad payload off windows": {"darwin", true, func(p map[string]any) { p["observeLevel"] = "scan" }, "invalid_payload"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			s := installObserveSeams(t, c.goos, c.elevated)
			r := runObserve(observePayload(c.mutate))
			if r.Status != "failed" || r.ExitCode == 0 || r.Error != c.code || r.Stdout != "" {
				t.Fatalf("result = %+v, want failed with error %q and no stdout", r, c.code)
			}
			if s.collected != 0 {
				t.Fatal("the collector ran on a refused command")
			}
		})
	}
}

// TestOemObserveInvalidResultNotSent: a result that fails the contract (here,
// a list over its bound that skipped Bound) is never put on the wire.
func TestOemObserveInvalidResultNotSent(t *testing.T) {
	s := installObserveSeams(t, "windows", true)
	s.result = func(req observe.Request) observe.Result {
		r := observe.Collect(context.Background(), observe.Host{}, req, "0.131.0")
		r.Errors = append(r.Errors, observe.StepErr{Step: "bad step!", Code: "x"})
		return r
	}
	r := runObserve(observePayload(nil))
	if r.Status != "failed" || r.Error != "result_invalid" || r.Stdout != "" {
		t.Fatalf("result = %+v", r)
	}
}
