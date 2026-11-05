package heartbeat

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/oemupdates"
	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func installBitLockerSeams(t *testing.T, resume func() (bitlockerguard.Result, error)) *int {
	t.Helper()
	passes := 0
	prevResume, prevDeps := oemResumeBitLocker, oemGuardDeps
	oemResumeBitLocker = func(context.Context, oemupdates.Deps, bitlockerguard.Deps) (bitlockerguard.Result, error) {
		passes++
		return resume()
	}
	oemGuardDeps = func() bitlockerguard.Deps { return bitlockerguard.Deps{} }
	t.Cleanup(func() { oemResumeBitLocker, oemGuardDeps = prevResume, prevDeps })
	return &passes
}

func TestOemBitLockerPassSaysWhenTheRecordClosed(t *testing.T) {
	cases := []struct {
		action bitlockerguard.Action
		err    error
		closed bool
	}{
		{bitlockerguard.ActionResumed, nil, true},
		{bitlockerguard.ActionCleared, nil, true},
		{bitlockerguard.ActionHeld, nil, false},
		{bitlockerguard.ActionNone, nil, false},
		{bitlockerguard.ActionHeld, errors.New("access denied"), false},
	}
	for _, c := range cases {
		installBitLockerSeams(t, func() (bitlockerguard.Result, error) {
			return bitlockerguard.Result{Action: c.action}, c.err
		})
		w := &oemBitLockerWatch{}
		if got := w.pass(context.Background(), oemupdates.Deps{}); got != c.closed {
			t.Errorf("%s err=%v: closed=%v, want %v", c.action, c.err, got, c.closed)
		}
	}
}

// Every ten minutes for days is not a useful number of warnings about one failure.
func TestOemBitLockerPassWarnsOncePerDistinctFailure(t *testing.T) {
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	failure := errors.New("access denied")
	installBitLockerSeams(t, func() (bitlockerguard.Result, error) {
		return bitlockerguard.Result{Action: bitlockerguard.ActionHeld}, failure
	})
	w := &oemBitLockerWatch{}
	for i := 0; i < 5; i++ {
		w.pass(context.Background(), oemupdates.Deps{})
	}
	if got := strings.Count(buf.String(), "level=WARN"); got != 1 {
		t.Fatalf("WARN count = %d, want 1:\n%s", got, buf.String())
	}
	failure = errors.New("record corrupt")
	w.pass(context.Background(), oemupdates.Deps{})
	if got := strings.Count(buf.String(), "level=WARN"); got != 2 {
		t.Fatalf("a new failure must warn: count = %d", got)
	}
}

func TestOemBitLockerWatchTicksAndVerifiesWhenTheRecordCloses(t *testing.T) {
	results := []bitlockerguard.Result{
		{Action: bitlockerguard.ActionNone},
		{Action: bitlockerguard.ActionHeld},
		{Action: bitlockerguard.ActionResumed},
	}
	passes := installBitLockerSeams(t, func() (bitlockerguard.Result, error) {
		r := results[0]
		results = results[1:]
		return r, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tick := make(chan time.Time)
	verified := make(chan struct{}, 8)
	done := make(chan struct{})
	w := &oemBitLockerWatch{}
	go func() {
		defer close(done)
		w.run(ctx, oemupdates.Deps{}, tick, func() { verified <- struct{}{} })
	}()
	for i := 0; i < 3; i++ {
		tick <- time.Now()
	}
	select {
	case <-verified:
	case <-time.After(5 * time.Second):
		t.Fatal("no verification after the record closed")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the watch must stop with the agent")
	}
	if *passes != 3 {
		t.Fatalf("passes = %d", *passes)
	}
	if len(verified) != 0 {
		t.Fatalf("verified %d extra times: only a closed record has anything new to report", len(verified))
	}
}

// Verifying first would report "suspended" for a volume the guard is about to
// resume, and raise an alert for nothing.
func TestVerifyOemUpdatesRunsTheGuardFirst(t *testing.T) {
	prevGOOS, prevVerify := oemGOOS, oemVerifyPending
	t.Cleanup(func() { oemGOOS, oemVerifyPending = prevGOOS, prevVerify })
	oemGOOS = "windows"
	var order []string
	installBitLockerSeams(t, func() (bitlockerguard.Result, error) {
		order = append(order, "guard")
		return bitlockerguard.Result{Action: bitlockerguard.ActionNone}, nil
	})
	oemVerifyPending = func(context.Context, oemupdates.Deps, func(oemupdates.Verification) error) error {
		order = append(order, "verify")
		return nil
	}
	stop := make(chan struct{})
	close(stop) // the agent is stopping, so the watch loop ends at once
	done := make(chan struct{})
	go func() {
		defer close(done)
		(&Heartbeat{stopChan: stop}).verifyOemUpdates()
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("verifyOemUpdates must stop with the agent")
	}
	if strings.Join(order, ",") != "guard,verify" {
		t.Fatalf("order = %v", order)
	}
}

// The real lane is registered: the handler no longer answers lane_not_built.
func TestOemHandlerRunsTheSurfaceLane(t *testing.T) {
	s := installOemSeams(t, "windows", true)
	r := handleOemUpdateRun(nil, Command{ID: oemTestCmdID, Type: tools.CmdOemUpdateRun,
		Payload: oemPayload(t, func(p map[string]any) { p["lane"] = "surface" })})
	got := decodeOemResult(t, r)
	if s.ran == nil || errorCodeString(got) == "lane_not_built" {
		t.Fatalf("ran=%v result=%+v", s.ran != nil, got)
	}
}
