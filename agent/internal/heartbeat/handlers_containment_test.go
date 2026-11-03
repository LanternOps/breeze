package heartbeat

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/isolation"
	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/wire"
)

type containmentFake struct {
	isolated   atomic.Int32
	startup    atomic.Int32
	ticks      atomic.Int32
	reconciles atomic.Int32
	entered    chan struct{}
	unblock    chan struct{}
}

func (f *containmentFake) HandleIsolate(context.Context, map[string]any) isolation.CommandOutcome {
	f.isolated.Add(1)
	return isolation.CommandOutcome{Status: "completed", Result: &isolation.CommandResultBody{IsolationID: containmentID, Generation: 1, State: "verified"}}
}
func (f *containmentFake) HandleRelease(context.Context, map[string]any) isolation.CommandOutcome {
	return isolation.CommandOutcome{Status: "failed", ErrorCode: wire.ErrCodeIsolationEpisodeMismatch}
}
func (f *containmentFake) Reconcile(ctx context.Context, _ *isolation.DesiredBlock) {
	f.reconciles.Add(1)
	if f.entered != nil {
		select {
		case f.entered <- struct{}{}:
		default:
		}
		select {
		case <-f.unblock:
		case <-ctx.Done():
		}
	}
}
func (f *containmentFake) Startup(context.Context)   { f.startup.Add(1) }
func (f *containmentFake) Tick(context.Context)      { f.ticks.Add(1) }
func (f *containmentFake) Report() *isolation.Report { return nil }
func (f *containmentFake) Active() bool              { return false }

func TestContainmentDispatchValidationBeforeManager(t *testing.T) {
	f := &containmentFake{}
	h := &Heartbeat{config: &config.Config{ServerURL: "https://control.example.test"}, containment: &containmentRuntime{manager: f}}
	p := containmentPayload(time.Now())
	p["parameters"].(map[string]any)["generation"] = 1.5
	r := handleExecuteContainment(h, Command{Payload: p})
	if r.Status != "failed" || r.ExitCode == 0 || r.ErrorCode != wire.ErrCodeIsolationInvalidSpec || f.isolated.Load() != 0 {
		t.Fatal("invalid command reached manager or wrong refusal")
	}
	r = handleExecuteContainment(h, Command{Payload: containmentPayload(time.Now())})
	if r.Status != "completed" || r.ExitCode != 0 || f.isolated.Load() != 1 {
		t.Fatal("valid command did not reach manager")
	}
	var body isolation.CommandResultBody
	if err := json.Unmarshal([]byte(r.Stdout), &body); err != nil || body.IsolationID != containmentID || body.Generation != 1 {
		t.Fatal("missing structured command result")
	}
	if strings.Contains(r.Stdout, "breakGlassSecret") {
		t.Fatal("secret field in result")
	}
	r = handleExecuteContainment(h, Command{Payload: map[string]any{"actionType": "usb_block"}})
	if r.ErrorCode == wire.ErrCodeIsolationInvalidSpec || f.isolated.Load() != 1 {
		t.Fatal("other containment changed routing")
	}
}

func TestReleaseContainmentEpisodeMismatch(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "empty", true: "other episode"}[existing], func(t *testing.T) {
			dir := t.TempDir()
			if existing {
				j := journal.New()
				j.Phase = journal.PhaseCommitted
				j.Episode = &journal.EpisodeRecord{IsolationID: containmentID, Generation: 1, State: isolation.StateVerified, ExpiresAt: time.Now().Add(time.Hour)}
				if err := journal.Save(journal.Path(dir), j); err != nil {
					t.Fatal(err)
				}
			}
			h := &Heartbeat{containment: &containmentRuntime{manager: isolation.NewManager(isolation.ManagerDeps{DataDir: dir})}}
			handler, ok := handlerRegistry[tools.CmdReleaseContainment]
			if !ok {
				t.Fatal("release handler missing")
			}
			r := handler(h, Command{Payload: map[string]any{"isolationId": "10000000-0000-4000-8000-000000000002", "generation": float64(1), "reason": "console"}})
			if r.Status != "failed" || r.ExitCode == 0 || r.ErrorCode != wire.ErrCodeIsolationEpisodeMismatch {
				t.Fatalf("mismatch outcome: %+v", r)
			}
		})
	}
}

func TestContainmentOutcomeConversion(t *testing.T) {
	for _, status := range []string{"completed", "failed"} {
		o := isolation.CommandOutcome{Status: status, Error: "refused", ErrorCode: wire.ErrCodeIsolationApplyError, Result: &isolation.CommandResultBody{IsolationID: containmentID, Generation: 2, State: "failed"}}
		r := containmentCommandResult(o)
		if r.Status != status || (r.ExitCode != 0) != (status == "failed") || r.ErrorCode != o.ErrorCode || len(r.Stdout) > 8000 || !json.Valid([]byte(r.Stdout)) {
			t.Fatal("conversion violated command contract")
		}
	}
	r := containmentCommandResult(isolation.CommandOutcome{Status: "failed", ErrorCode: wire.ErrCodeIsolationInvalidSpec})
	if r.Stdout != "" || r.ExitCode == 0 {
		t.Fatal("nil result conversion")
	}
	r = containmentCommandResult(isolation.CommandOutcome{Status: "completed", Result: &isolation.CommandResultBody{IsolationID: strings.Repeat("x", 9000)}})
	if r.Status != "failed" || r.ExitCode == 0 || r.Stdout != "" {
		t.Fatal("oversized result must fail without partial JSON")
	}
}

func TestContainmentWorkerSerializesAndCancels(t *testing.T) {
	f := &containmentFake{entered: make(chan struct{}, 1), unblock: make(chan struct{})}
	r := newContainmentRuntime(f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() { r.run(ctx, ticks); close(done) }()
	block := &isolation.DesiredBlock{NetworkIsolation: &isolation.Desired{Desired: "released"}}
	r.enqueue(block)
	select {
	case <-f.entered:
	case <-time.After(time.Second):
		t.Fatal("reconcile not started")
	}
	submitted := make(chan struct{})
	go func() {
		for i := 0; i < 100; i++ {
			r.enqueue(block)
		}
		close(submitted)
	}()
	select {
	case <-submitted:
	case <-time.After(time.Second):
		t.Fatal("response blocked on probe")
	}
	if f.startup.Load() != 1 || f.reconciles.Load() != 1 {
		t.Fatal("startup or single flight violated")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("worker did not stop")
	}
	f2 := &containmentFake{}
	r2 := newContainmentRuntime(f2)
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	done2 := make(chan struct{})
	go func() { r2.run(ctx2, ticks); close(done2) }()
	select {
	case ticks <- time.Now():
	case <-time.After(time.Second):
		t.Fatal("tick not consumed")
	}
	cancel2()
	<-done2
	if f2.ticks.Load() != 1 {
		t.Fatal("periodic tick not delivered")
	}
}

func TestContainmentResponseRejectsUnsafeDesired(t *testing.T) {
	f := &containmentFake{}
	r := newContainmentRuntime(f)
	h := &Heartbeat{config: &config.Config{ServerURL: "https://control.example.test"}, containment: r}
	h.reconcileContainment(nil)
	h.reconcileContainment(&isolation.DesiredBlock{})
	h.reconcileContainment(&isolation.DesiredBlock{NetworkIsolation: &isolation.Desired{Desired: "isolated"}})
	select {
	case <-r.desired:
		t.Fatal("invalid response was queued")
	default:
	}
	h.reconcileContainment(&isolation.DesiredBlock{NetworkIsolation: &isolation.Desired{Desired: "released"}})
	select {
	case <-r.desired:
	default:
		t.Fatal("release tombstone was dropped")
	}
}

func TestContainmentBlocksUpgradeWhileActive(t *testing.T) {
	if (&Heartbeat{}).containmentBlocksUpgrade() {
		t.Fatal("no containment runtime must not block upgrades")
	}
	if (&Heartbeat{containment: &containmentRuntime{manager: &containmentFake{}}}).containmentBlocksUpgrade() {
		t.Fatal("inactive containment must not block upgrades")
	}
	if !(&Heartbeat{containment: &containmentRuntime{manager: activeContainmentFake{&containmentFake{}}}}).containmentBlocksUpgrade() {
		t.Fatal("active containment must block upgrades")
	}
}

type activeContainmentFake struct{ *containmentFake }

func (activeContainmentFake) Active() bool { return true }

func TestContainmentRuntimeUnavailableIsNotInvalidSpec(t *testing.T) {
	r := handlerRegistry[tools.CmdReleaseContainment](&Heartbeat{}, Command{Payload: map[string]any{}})
	if r.Status != "failed" || r.ErrorCode != wire.ErrCodeIsolationMechanismUnavailable {
		t.Fatalf("unavailable runtime outcome: %+v", r)
	}
	r = handlerRegistry[tools.CmdExecuteContainment](&Heartbeat{}, Command{Payload: map[string]any{"actionType": "network_isolation"}})
	if r.Status != "failed" || r.ErrorCode != wire.ErrCodeIsolationMechanismUnavailable {
		t.Fatalf("unavailable runtime outcome: %+v", r)
	}
}
