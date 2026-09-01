package main

import (
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/userhelper"
)

type stubSupervisor struct {
	result userhelper.SupervisorResult
	calls  int
	// onRun runs before the result is returned, so a test can simulate
	// shutdown arriving while the supervisor is still working.
	onRun func(done <-chan struct{})
}

func (s *stubSupervisor) Run(done <-chan struct{}) userhelper.SupervisorResult {
	s.calls++
	if s.onRun != nil {
		s.onRun(done)
	}
	return s.result
}

// recordingWaiter captures the cooldown durations it was asked to wait.
type recordingWaiter struct {
	waited    []time.Duration
	interrupt bool // return false (shutdown observed) instead of completing
}

func (r *recordingWaiter) wait(d time.Duration, _ <-chan struct{}) bool {
	r.waited = append(r.waited, d)
	return !r.interrupt
}

func TestRunSupervisedHelperExitCodes(t *testing.T) {
	tests := []struct {
		name        string
		result      userhelper.SupervisorResult
		wantCode    int
		wantCooldwn bool
	}{
		{
			name:        "clean shutdown exits zero without cooling down",
			result:      userhelper.SupervisorResult{Reason: userhelper.StopShutdown},
			wantCode:    exitOK,
			wantCooldwn: false,
		},
		{
			name: "shutdown that interrupted an error still exits zero",
			result: userhelper.SupervisorResult{
				Reason: userhelper.StopShutdown,
				Err:    errors.New("recv: EOF"),
			},
			wantCode:    exitOK,
			wantCooldwn: false,
		},
		{
			name: "permanent rejection cools down then exits fatal",
			result: userhelper.SupervisorResult{
				Reason: userhelper.StopFatal,
				Err:    &userhelper.PermanentRejectError{Code: "binary_path_unknown", Reason: "nope"},
			},
			wantCode:    exitFatal,
			wantCooldwn: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			sup := &stubSupervisor{result: tc.result}
			waiter := &recordingWaiter{}
			done := make(chan struct{})

			got := runSupervisedHelper(sup, done, fatalCooldown, waiter.wait)

			if got != tc.wantCode {
				t.Errorf("exit code = %d, want %d", got, tc.wantCode)
			}
			if sup.calls != 1 {
				t.Errorf("supervisor ran %d times, want 1", sup.calls)
			}
			if tc.wantCooldwn {
				if len(waiter.waited) != 1 || waiter.waited[0] != fatalCooldown {
					t.Errorf("expected a single %v cooldown, got %v", fatalCooldown, waiter.waited)
				}
			} else if len(waiter.waited) != 0 {
				t.Errorf("expected no cooldown, got %v", waiter.waited)
			}
		})
	}
}

func TestRunSupervisedHelperCooldownIsInterruptibleByShutdown(t *testing.T) {
	sup := &stubSupervisor{result: userhelper.SupervisorResult{
		Reason: userhelper.StopFatal,
		Err:    &userhelper.PermanentRejectError{Code: "sid_mismatch"},
	}}
	waiter := &recordingWaiter{interrupt: true}
	done := make(chan struct{})

	got := runSupervisedHelper(sup, done, fatalCooldown, waiter.wait)

	// A SIGTERM during the cooldown must not change the classification —
	// the rejection really was fatal — but it must not be ignored either.
	if got != exitFatal {
		t.Errorf("exit code = %d, want %d", got, exitFatal)
	}
	if len(waiter.waited) != 1 {
		t.Errorf("expected the cooldown to be attempted once, got %v", waiter.waited)
	}
}

// The launchd LaunchAgent for this binary sets KeepAlive=true with
// ThrottleInterval=10, so launchd respawns the helper ~10s after ANY exit.
// The fatal cooldown exists purely to keep a permanent rejection from
// becoming a 10-second respawn loop — and every respawn re-runs the startup
// capture probe, which re-fires the macOS Screen Recording prompt (#4194).
// If the cooldown ever drops near the throttle interval it stops doing its
// job, so pin the relationship rather than the bare number.
func TestFatalCooldownDwarfsLaunchdThrottleInterval(t *testing.T) {
	const launchdThrottleInterval = 10 * time.Second
	if fatalCooldown < 20*launchdThrottleInterval {
		t.Errorf("fatalCooldown %v is too close to launchd's %v ThrottleInterval to suppress a respawn storm",
			fatalCooldown, launchdThrottleInterval)
	}
}

// The whole point of #4194 is that a transient IPC gap must not leave Desktop
// Access greyed out for long. Guard the tuning against a future edit that
// quietly reintroduces the Windows-style 30s floor.
func TestDesktopHelperReconnectPolicyIsTunedForFastRecovery(t *testing.T) {
	p := desktopHelperReconnectPolicy()

	if p.MinBackoff > 2*time.Second {
		t.Errorf("MinBackoff = %v; a transient socket gap must be retried within a couple of seconds", p.MinBackoff)
	}
	if p.MinBackoff <= 0 {
		t.Errorf("MinBackoff = %v; a zero floor would spin hot against a missing socket", p.MinBackoff)
	}
	if p.MaxBackoff < p.MinBackoff {
		t.Errorf("MaxBackoff %v is below MinBackoff %v", p.MaxBackoff, p.MinBackoff)
	}
	if p.MaxBackoff > 2*time.Minute {
		t.Errorf("MaxBackoff = %v; the helper should recover within a minute or two of the agent returning", p.MaxBackoff)
	}
	if p.StableThreshold <= 0 {
		t.Errorf("StableThreshold = %v; without it a flapping connection resets the backoff every attempt", p.StableThreshold)
	}
}
