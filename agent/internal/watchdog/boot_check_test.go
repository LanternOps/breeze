package watchdog

import (
	"testing"
	"time"
)

const testBootDeadline = 2 * time.Minute

// #12291: after a reboot agent.state still names the previous boot's agent
// (here PID 5824, now dead) while SCM already runs the new agent as PID 3412.
// The watchdog must wait for it, not restart it.
func TestEvaluateBootCheck_StalePIDHealthyServiceHolds(t *testing.T) {
	got := EvaluateBootCheck(BootCheckInput{
		Service:       AgentServiceStatus{State: AgentServiceRunning, PID: 3412},
		StatePID:      5824,
		StatePIDAlive: false,
		Elapsed:       time.Second,
		Deadline:      testBootDeadline,
	})
	if got != BootHold {
		t.Fatalf("decision = %v, want hold", got)
	}
}

// A fresh install has no agent.state at all (PID 0): same rule.
func TestEvaluateBootCheck_NoStateFileServiceStartingHolds(t *testing.T) {
	got := EvaluateBootCheck(BootCheckInput{
		Service:  AgentServiceStatus{State: AgentServiceStarting},
		StatePID: 0,
		Elapsed:  time.Second,
		Deadline: testBootDeadline,
	})
	if got != BootHold {
		t.Fatalf("decision = %v, want hold", got)
	}
}

// The agent really is gone: recovery proceeds immediately, as before.
func TestEvaluateBootCheck_StalePIDServiceStoppedRecovers(t *testing.T) {
	got := EvaluateBootCheck(BootCheckInput{
		Service:       AgentServiceStatus{State: AgentServiceStopped},
		StatePID:      5824,
		StatePIDAlive: false,
		Elapsed:       time.Second,
		Deadline:      testBootDeadline,
	})
	if got != BootNotFound {
		t.Fatalf("decision = %v, want not_found", got)
	}
}

// The previous boot's PID now belongs to an unrelated process. Its liveness
// must not stand in for the agent when the service manager says stopped.
func TestEvaluateBootCheck_ReusedStalePIDDoesNotMaskStoppedService(t *testing.T) {
	got := EvaluateBootCheck(BootCheckInput{
		Service:       AgentServiceStatus{State: AgentServiceStopped},
		StatePID:      5824,
		StatePIDAlive: true, // unrelated process reusing the old PID
		Elapsed:       time.Second,
		Deadline:      testBootDeadline,
	})
	if got != BootNotFound {
		t.Fatalf("decision = %v, want not_found", got)
	}
}

// Without a service-manager answer the decision is the pre-#12291 one: a live
// state-file PID hands off to the ordinary checks, a dead one is not found.
func TestEvaluateBootCheck_UnknownServiceFallsBackToProcessEvidence(t *testing.T) {
	unknown := AgentServiceStatus{State: AgentServiceUnknown, Detail: "query failed"}
	if got := EvaluateBootCheck(BootCheckInput{
		Service: unknown, StatePID: 5824, StatePIDAlive: true,
		Elapsed: time.Second, Deadline: testBootDeadline,
	}); got != BootRelease {
		t.Fatalf("live PID: decision = %v, want release", got)
	}
	if got := EvaluateBootCheck(BootCheckInput{
		Service: unknown, StatePID: 5824, StatePIDAlive: false,
		Elapsed: time.Second, Deadline: testBootDeadline,
	}); got != BootNotFound {
		t.Fatalf("dead PID: decision = %v, want not_found", got)
	}
	if got := EvaluateBootCheck(BootCheckInput{
		Service: unknown, StatePID: 0,
		Elapsed: time.Second, Deadline: testBootDeadline,
	}); got != BootNotFound {
		t.Fatalf("no PID: decision = %v, want not_found", got)
	}
}

// The hold is bounded. An agent the service manager calls running that never
// opens IPC and never runs its heartbeat loop (wedged during startup) is
// recovered once the deadline passes.
func TestEvaluateBootCheck_HoldEndsAtDeadline(t *testing.T) {
	running := AgentServiceStatus{State: AgentServiceRunning, PID: 3412}
	if got := EvaluateBootCheck(BootCheckInput{
		Service: running, StatePID: 3412, StatePIDAlive: true,
		Elapsed: testBootDeadline, Deadline: testBootDeadline,
	}); got != BootNotFound {
		t.Fatalf("wedged agent at deadline: decision = %v, want not_found", got)
	}
	// Heartbeating but IPC broken: hand off to the ordinary checks rather
	// than restart an agent whose heartbeat loop is demonstrably running.
	if got := EvaluateBootCheck(BootCheckInput{
		Service: running, StatePID: 3412, StatePIDAlive: true, AgentAlive: true,
		Elapsed: testBootDeadline, Deadline: testBootDeadline,
	}); got != BootRelease {
		t.Fatalf("heartbeating agent at deadline: decision = %v, want release", got)
	}
}

func TestAgentServiceStatusFromSnapshot(t *testing.T) {
	cases := []struct {
		in    serviceSnapshot
		state AgentServiceState
	}{
		{serviceSnapshot{State: serviceRunning, PID: 3412}, AgentServiceRunning},
		{serviceSnapshot{State: serviceStartPending}, AgentServiceStarting},
		{serviceSnapshot{State: serviceContinuePending}, AgentServiceStarting},
		{serviceSnapshot{State: serviceStopped}, AgentServiceStopped},
		{serviceSnapshot{State: serviceStopPending, PID: 3412}, AgentServiceUnknown},
		{serviceSnapshot{State: servicePaused}, AgentServiceUnknown},
	}
	for _, tc := range cases {
		got := agentServiceStatusFromSnapshot(tc.in)
		if got.State != tc.state || got.PID != tc.in.PID {
			t.Errorf("%s: got %+v, want state=%s pid=%d", tc.in.State, got, tc.state, tc.in.PID)
		}
	}
}

func TestParseSystemctlShow(t *testing.T) {
	cases := []struct {
		name  string
		out   string
		state AgentServiceState
		pid   int
	}{
		{"running", "LoadState=loaded\nActiveState=active\nMainPID=3412\n", AgentServiceRunning, 3412},
		{"activating", "LoadState=loaded\nActiveState=activating\nMainPID=0\n", AgentServiceStarting, 0},
		{"inactive", "LoadState=loaded\nActiveState=inactive\nMainPID=0\n", AgentServiceStopped, 0},
		{"failed", "LoadState=loaded\nActiveState=failed\nMainPID=0\n", AgentServiceStopped, 0},
		{"not installed", "LoadState=not-found\nActiveState=inactive\nMainPID=0\n", AgentServiceUnknown, 0},
		{"deactivating", "LoadState=loaded\nActiveState=deactivating\nMainPID=3412\n", AgentServiceUnknown, 3412},
		{"empty", "", AgentServiceUnknown, 0},
	}
	for _, tc := range cases {
		got := parseSystemctlShow(tc.out)
		if got.State != tc.state || got.PID != tc.pid {
			t.Errorf("%s: got %+v, want state=%s pid=%d", tc.name, got, tc.state, tc.pid)
		}
	}
}

func TestParseLaunchctlPrint(t *testing.T) {
	running := `system/com.breeze.agent = {
	active count = 1
	path = /Library/LaunchDaemons/com.breeze.agent.plist
	state = running
	pid = 3412
	endpoints = {
		"com.breeze.agent.ipc" = {
			state = not running
		}
	}
}
`
	if got := parseLaunchctlPrint(running); got.State != AgentServiceRunning || got.PID != 3412 {
		t.Fatalf("running: got %+v", got)
	}
	stopped := "system/com.breeze.agent = {\n\tstate = not running\n\tlast exit code = 1\n}\n"
	if got := parseLaunchctlPrint(stopped); got.State != AgentServiceStopped || got.PID != 0 {
		t.Fatalf("stopped: got %+v", got)
	}
	scheduled := "system/com.breeze.agent = {\n\tstate = spawn scheduled\n}\n"
	if got := parseLaunchctlPrint(scheduled); got.State != AgentServiceStarting {
		t.Fatalf("spawn scheduled: got %+v", got)
	}
	// A nested "state = running" (an endpoint, not the job) must not count.
	nested := "system/com.breeze.agent = {\n\tstate = not running\n\tendpoints = {\n\t\tstate = running\n\t}\n}\n"
	if got := parseLaunchctlPrint(nested); got.State != AgentServiceStopped {
		t.Fatalf("nested: got %+v", got)
	}
	if got := parseLaunchctlPrint(""); got.State != AgentServiceUnknown {
		t.Fatalf("empty: got %+v", got)
	}
}
