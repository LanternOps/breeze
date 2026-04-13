//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"golang.org/x/sys/windows/svc"
)

// installServiceStubs wires all three Execute test seams to stubs that
// record call ordering into events. Returns a release() func that
// unblocks any stub waiting on releaseCh (used by the unenrolled-path
// tests). Registers t.Cleanup to restore originals.
func installServiceStubs(t *testing.T) (events chan string, release func()) {
	t.Helper()
	origStart := startAgentFn
	origWait := waitForEnrollmentFn
	origLoop := runServiceLoopFn
	t.Cleanup(func() {
		startAgentFn = origStart
		waitForEnrollmentFn = origWait
		runServiceLoopFn = origLoop
	})

	events = make(chan string, 16)
	releaseCh := make(chan struct{})
	release = func() { close(releaseCh) }

	startAgentFn = func(cfg *config.Config) (*agentComponents, error) {
		events <- "startAgent"
		return &agentComponents{}, nil // zero-value; runServiceLoopFn never dereferences
	}
	waitForEnrollmentFn = func(ctx context.Context, cfgFile string) *config.Config {
		events <- "waitForEnrollment.enter"
		select {
		case <-releaseCh:
			events <- "waitForEnrollment.release"
			cfg, _ := config.Load(cfgFile)
			return cfg
		case <-ctx.Done():
			events <- "waitForEnrollment.cancelled"
			return nil
		}
	}
	runServiceLoopFn = func(comps *agentComponents, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
		events <- "runServiceLoop"
		for cr := range r {
			if cr.Cmd == svc.Stop || cr.Cmd == svc.Shutdown {
				changes <- svc.Status{State: svc.StopPending}
				return false, 0
			}
		}
		return false, 0
	}
	return events, release
}

// writeEnrolledConfigFile writes agent.yaml + secrets.yaml that
// config.Load + IsEnrolled will accept as enrolled. Returns the
// agent.yaml path. Uses a valid UUID format that passes
// config.ValidateTiered.
func writeEnrolledConfigFile(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("agent_id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\nserver_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	secretsPath := filepath.Join(dir, "secrets.yaml")
	if err := os.WriteFile(secretsPath, []byte("auth_token: test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// writeUnenrolledConfigFile writes an empty agent.yaml (no AgentID,
// no AuthToken) so config.Load succeeds but IsEnrolled returns false.
func writeUnenrolledConfigFile(t *testing.T, dir string) string {
	t.Helper()
	agentPath := filepath.Join(dir, "agent.yaml")
	if err := os.WriteFile(agentPath, []byte("server_url: https://test.example\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return agentPath
}

// runExecuteInGoroutine starts Execute in a goroutine with mock changes
// and request channels. Returns channels the test can drive.
func runExecuteInGoroutine(t *testing.T, s *breezeService) (changes chan svc.Status, requests chan svc.ChangeRequest, done chan struct{}) {
	t.Helper()
	changes = make(chan svc.Status, 16)
	requests = make(chan svc.ChangeRequest, 4)
	done = make(chan struct{})
	go func() {
		defer close(done)
		s.Execute(nil, requests, changes)
	}()
	return
}

func TestExecute_EnrolledPath_SignalsRunningAfterStartFn(t *testing.T) {
	dir := t.TempDir()
	cfgFile := writeEnrolledConfigFile(t, dir)

	events, _ := installServiceStubs(t)
	s := &breezeService{cfgFile: cfgFile}

	changes, requests, done := runExecuteInGoroutine(t, s)

	// Expected event sequence on enrolled path:
	// 1. startAgent (from stubbed startAgentFn)
	// 2. runServiceLoop (from stubbed runServiceLoopFn)
	if got := <-events; got != "startAgent" {
		t.Errorf("first event = %q, want startAgent", got)
	}
	if got := <-events; got != "runServiceLoop" {
		t.Errorf("second event = %q, want runServiceLoop", got)
	}

	// Drain changes. Expected: StartPending, Running. The Running signal
	// MUST arrive after the stubbed startAgentFn observed its call.
	first := <-changes
	if first.State != svc.StartPending {
		t.Errorf("first state = %v, want StartPending", first.State)
	}
	second := <-changes
	if second.State != svc.Running {
		t.Errorf("second state = %v, want Running", second.State)
	}

	// Tell Execute to stop so the goroutine terminates.
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Execute did not return within 1s of Stop")
	}
}

func TestExecute_UnenrolledPath_SignalsRunningBeforeWait(t *testing.T) {
	dir := t.TempDir()
	cfgFile := writeUnenrolledConfigFile(t, dir)

	events, release := installServiceStubs(t)
	s := &breezeService{cfgFile: cfgFile}

	changes, requests, done := runExecuteInGoroutine(t, s)

	// Expected: StartPending, Running before any waitForEnrollment.enter.
	first := <-changes
	if first.State != svc.StartPending {
		t.Errorf("first state = %v, want StartPending", first.State)
	}
	second := <-changes
	if second.State != svc.Running {
		t.Errorf("second state = %v, want Running", second.State)
	}

	// Now the stub should record that it entered waitForEnrollment.
	if got := <-events; got != "waitForEnrollment.enter" {
		t.Errorf("first event = %q, want waitForEnrollment.enter", got)
	}

	// Upgrade the on-disk config to enrolled, then release the stub
	// so the post-wait branch runs startAgentFn.
	_ = writeEnrolledConfigFile(t, dir)
	release()

	// Expected remaining event sequence: release, startAgent, runServiceLoop.
	if got := <-events; got != "waitForEnrollment.release" {
		t.Errorf("event after release = %q, want waitForEnrollment.release", got)
	}
	if got := <-events; got != "startAgent" {
		t.Errorf("event = %q, want startAgent", got)
	}
	if got := <-events; got != "runServiceLoop" {
		t.Errorf("event = %q, want runServiceLoop", got)
	}

	// Terminate.
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Execute did not return within 1s of Stop")
	}
}

func TestExecute_StopWhileWaiting(t *testing.T) {
	dir := t.TempDir()
	cfgFile := writeUnenrolledConfigFile(t, dir)

	events, _ := installServiceStubs(t)
	s := &breezeService{cfgFile: cfgFile}

	changes, requests, done := runExecuteInGoroutine(t, s)

	// Drain StartPending + Running.
	<-changes
	<-changes

	// Wait until the stub has entered waitForEnrollment.
	if got := <-events; got != "waitForEnrollment.enter" {
		t.Errorf("event = %q, want waitForEnrollment.enter", got)
	}

	// Stop without releasing the stub. The stub's ctx.Done() branch
	// should fire and the unenrolled path should cleanly return.
	requests <- svc.ChangeRequest{Cmd: svc.Stop}

	if got := <-events; got != "waitForEnrollment.cancelled" {
		t.Errorf("event = %q, want waitForEnrollment.cancelled", got)
	}

	// Expect a StopPending signal.
	select {
	case state := <-changes:
		if state.State != svc.StopPending {
			t.Errorf("state = %v, want StopPending", state.State)
		}
	case <-time.After(1 * time.Second):
		t.Fatal("no StopPending signal within 1s")
	}

	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("Execute did not return within 1s of Stop")
	}
}
