package heartbeat

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// Follow-ups from the #8320 review (#8382).

// identityRollbackController is a rollback controller whose Active state the
// test flips, standing in for a rollback that starts or ends mid-sync.
type identityRollbackController struct {
	fakeRollbackController
	active atomic.Bool
}

func (c *identityRollbackController) Active() bool { return c.active.Load() }

func waitForIdentityCondition(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting until %s", what)
}

// --- 1. A pending identity restart takes no new work -----------------------

// The restart waits for the commands already running. A beat sent during that
// wait could deliver new ones that the restart then cuts off, so beats stop
// once the restart is scheduled, the way they stop for a self-update. Queued
// commands stay queued for the restarted process.
func TestPendingIdentityRestartSkipsHeartbeats(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	if reason := h.beatSkipReason(); reason != "" {
		t.Fatalf("an idle agent skipped its beat: %q", reason)
	}
	running := h.trackInFlight(time.Now(), time.Hour) // holds the restart in its wait

	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("assertion not accepted")
	}
	if h.beatSkipReason() == "" {
		t.Fatal("a beat would be sent, and could deliver commands, while the identity restart waits")
	}
	h.untrackInFlight(running)
	waitForRestart(t, s)

	// The restart was requested; this process is about to be replaced and
	// still sends nothing.
	if h.beatSkipReason() == "" {
		t.Fatal("beats resumed while the requested restart lands")
	}
	// Bounded: an agent whose restart never lands heartbeats again.
	s.now = s.now.Add(identityIntakePauseMax + time.Second)
	if reason := h.beatSkipReason(); reason != "" {
		t.Fatalf("beats still skipped past the bound: %q", reason)
	}
}

// The skip must stay short of the server's offline threshold in the normal
// case, and bounded overall.
func TestIdentityIntakePauseIsBounded(t *testing.T) {
	if identityIntakePauseMax < identityRestartMaxJitter+identityRestartMaxWait {
		t.Fatalf("the pause (%v) ends before the restart it covers (%v)", identityIntakePauseMax, identityRestartMaxJitter+identityRestartMaxWait)
	}
	if identityIntakePauseMax > 10*time.Minute {
		t.Fatalf("the pause (%v) is not tightly bounded", identityIntakePauseMax)
	}
	if identityIntakePauseMax >= identityRestartPendingMax {
		t.Fatalf("the pause (%v) must end before the pending-restart backstop (%v)", identityIntakePauseMax, identityRestartPendingMax)
	}
}

// A restart that fails reopens the gate, and beats with it.
func TestFailedIdentityRestartResumesHeartbeats(t *testing.T) {
	s := withIdentitySeams(t, nil)
	s.restartErr = errors.New("powershell.exe could not start")
	h := identityTestHeartbeat()

	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("assertion not accepted")
	}
	waitForRestart(t, s)
	waitForIdentityCondition(t, "beats resume after the failed restart", func() bool { return h.beatSkipReason() == "" })
	if h.identitySync.restartRequested.Load() {
		t.Fatal("a failed restart left the gate closed")
	}
}

func withIdentityTestHandler(t *testing.T, cmdType string) *atomic.Int32 {
	t.Helper()
	var ran atomic.Int32
	orig, hadOrig := handlerRegistry[cmdType]
	handlerRegistry[cmdType] = func(*Heartbeat, Command) tools.CommandResult {
		ran.Add(1)
		return tools.CommandResult{Status: "completed"}
	}
	t.Cleanup(func() {
		if hadOrig {
			handlerRegistry[cmdType] = orig
		} else {
			delete(handlerRegistry, cmdType)
		}
	})
	return &ran
}

// The WebSocket delivers commands without a beat. While the restart is
// pending, new work is refused with a reason (the same way a shutting-down
// agent refuses it), but a session already open keeps its input and can be
// closed, and a cancel still stops a running script.
func TestPendingIdentityRestartRefusesNewWebSocketWork(t *testing.T) {
	s := withIdentitySeams(t, nil)
	s.restartErr = errors.New("restart unavailable")
	h := identityTestHeartbeat()
	h.stopChan = make(chan struct{})
	h.accepting.Store(true)

	newWork := withIdentityTestHandler(t, tools.CmdTerminalStart)
	sessionInput := withIdentityTestHandler(t, tools.CmdTerminalData)

	running := h.trackInFlight(time.Now(), time.Hour)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("assertion not accepted")
	}

	refused := h.HandleCommand(websocket.Command{ID: "ws-new", Type: tools.CmdTerminalStart})
	if refused.Status != "failed" || refused.ExitCode != 1 || !strings.Contains(refused.Error, "restarting") || newWork.Load() != 0 {
		t.Fatalf("new work during the identity restart: %+v ran=%d", refused, newWork.Load())
	}
	for _, admitted := range []string{tools.CmdTerminalData, tools.CmdTerminalResize, tools.CmdTerminalStop, tools.CmdStopDesktop,
		tools.CmdDesktopStreamStop, tools.CmdDesktopInput, tools.CmdDesktopConfig, tools.CmdTunnelData, tools.CmdTunnelClose,
		tools.CmdScriptCancel, tools.CmdScriptListRunning, tools.CmdNetworkDiagnosticCancel,
		tools.CmdCancelReboot, tools.CmdBackupStop} {
		if !admittedDuringIdentityRestart(admitted) {
			t.Fatalf("%s is refused although it only continues or stops existing work", admitted)
		}
	}
	for _, starts := range []string{tools.CmdTerminalStart, tools.CmdStartDesktop, tools.CmdDesktopStreamStart, tools.CmdTunnelOpen,
		tools.CmdRunScript, tools.CmdInstallPatches, tools.CmdAgentRollbackV1, tools.CmdBackupRun} {
		if admittedDuringIdentityRestart(starts) {
			t.Fatalf("%s starts new work and is admitted during the identity restart", starts)
		}
	}
	if res := h.HandleCommand(websocket.Command{ID: "ws-input", Type: tools.CmdTerminalData}); res.Status != "completed" || sessionInput.Load() != 1 {
		t.Fatalf("input for an open session was refused: %+v", res)
	}

	// The restart fails: the agent takes new work again.
	h.untrackInFlight(running)
	waitForRestart(t, s)
	waitForIdentityCondition(t, "the gate reopens", func() bool { return !h.identitySync.restartRequested.Load() })
	if res := h.HandleCommand(websocket.Command{ID: "ws-after", Type: tools.CmdTerminalStart}); res.Status != "completed" || newWork.Load() != 1 {
		t.Fatalf("new work still refused after the restart failed: %+v", res)
	}
}

// --- 2. A rollback owns the restart -----------------------------------------

func TestIdentityAssertionIsDeferredWhileARollbackIsActive(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	rollback := &identityRollbackController{}
	rollback.active.Store(true)
	h.rollbackController = rollback

	if h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("scheduled an identity restart during a rollback")
	}
	if s.persisted.Load() != 0 || h.beatSkipReason() != "" || h.identityRejectionForBeat() != nil {
		t.Fatalf("an active rollback must schedule nothing: persisted=%d skip=%q", s.persisted.Load(), h.beatSkipReason())
	}
	if _, ok := readIdentityRestartMarker(s.markerPath); ok {
		t.Fatal("a restart marker was written for a restart that was never scheduled")
	}
	expectNoRestart(t, s, 50*time.Millisecond)

	// The server re-signs every beat; once the rollback is over the next one applies.
	rollback.active.Store(false)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("the identity was not applied after the rollback ended")
	}
	waitForRestart(t, s)
}

// A rollback can start during the jitter or the in-flight wait. The restart
// re-checks right before it fires and yields; the marker is put back so the
// restart that never happened does not count as an attempt, and the gate is
// reopened so the next beat re-evaluates.
func TestIdentityRestartYieldsToARollbackThatStartsDuringTheWait(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	rollback := &identityRollbackController{}
	h.rollbackController = rollback

	running := h.trackInFlight(time.Now(), time.Hour)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("assertion not accepted")
	}
	rollback.active.Store(true)
	h.untrackInFlight(running)

	expectNoRestart(t, s, 100*time.Millisecond)
	waitForIdentityCondition(t, "the gate reopens", func() bool { return !h.identitySync.restartRequested.Load() })
	if reason := h.beatSkipReason(); reason != "" {
		t.Fatalf("beats still skipped after the restart yielded to the rollback: %q", reason)
	}
	if m, ok := readIdentityRestartMarker(s.markerPath); ok {
		t.Fatalf("the restart that yielded left a marker counting it as an attempt: %+v", m)
	}

	// The rollback ends without a restart: the next beat applies the identity,
	// not held back by the cooldown of a restart that never happened.
	rollback.active.Store(false)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("the identity was not re-applied after the rollback")
	}
	waitForRestart(t, s)
	if m, ok := readIdentityRestartMarker(s.markerPath); !ok || m.Attempts != 1 {
		t.Fatalf("attempt count after the yielded restart: %+v ok=%v, want 1", m, ok)
	}
}

// The yield puts back a marker that was already there (a first attempt whose
// cooldown has passed) rather than dropping its count.
func TestYieldedIdentityRestartRestoresThePreviousMarker(t *testing.T) {
	s := withIdentitySeams(t, nil)
	h := identityTestHeartbeat()
	rollback := &identityRollbackController{}
	h.rollbackController = rollback
	previous := identityRestartMarker{RestartedAt: s.now.Add(-identityRestartCooldown - time.Minute).UTC(), OrgID: identityTestOrgB, SiteID: identityTestSiteB, Attempts: 1}
	writeIdentityTestMarker(t, s.markerPath, previous)

	running := h.trackInFlight(time.Now(), time.Hour)
	if !h.applyIdentityAssertion(goldenAssertion()) {
		t.Fatal("second attempt not scheduled")
	}
	if m, _ := readIdentityRestartMarker(s.markerPath); m.Attempts != 2 {
		t.Fatalf("second attempt not recorded before the wait: %+v", m)
	}
	rollback.active.Store(true)
	h.untrackInFlight(running)
	waitForIdentityCondition(t, "the gate reopens", func() bool { return !h.identitySync.restartRequested.Load() })
	expectNoRestart(t, s, 20*time.Millisecond)
	if m, ok := readIdentityRestartMarker(s.markerPath); !ok || m.Attempts != 1 || !m.RestartedAt.Equal(previous.RestartedAt) {
		t.Fatalf("previous marker not restored: %+v ok=%v", m, ok)
	}
}

// A rollback command delivered in the same response as the assertion becomes
// active only once its handler runs; the identity restart must not be
// scheduled against it in the meantime.
func TestRollbackInTheSameResponseDefersTheIdentityRestart(t *testing.T) {
	srv := newRotationServer(t)
	h, _ := newRotationTestHeartbeat(t, srv.URL)
	h.tunnelMgr = &tunnel.Manager{}
	h.config.AgentID = identityTestAgentID
	h.config.DeviceID = identityTestDeviceID
	h.config.OrgID, h.config.SiteID = identityTestOrgA, identityTestSiteA
	h.config.PinnedManifestPubKeys = identityTestPinned()
	h.rollbackController = &identityRollbackController{}
	s := withIdentitySeams(t, nil)
	nonce := identityTestNonce
	h.identitySync.nonce.Store(&nonce)

	// accepting=false: the command loop refuses the rollback command itself,
	// so only the pre-scan of the response can see it.
	h.processHeartbeatResponse(&HeartbeatResponse{
		IdentityAssertion: goldenAssertion(),
		Commands:          []Command{{ID: "rb-1", Type: tools.CmdAgentRollbackV1}},
	})
	if s.persisted.Load() != 0 || h.identitySync.restartRequested.Load() {
		t.Fatalf("identity restart scheduled alongside a rollback: persisted=%d", s.persisted.Load())
	}
	expectNoRestart(t, s, 50*time.Millisecond)
}

// --- 3. The agent tells the server why it refused ---------------------------

func TestIdentityAssertionRefusalIsReportedOnTheNextBeat(t *testing.T) {
	otherKey := ed25519.NewKeyFromSeed(make([]byte, ed25519.SeedSize))
	tests := map[string]struct {
		setup    func(t *testing.T, s *identitySeams, h *Heartbeat)
		mutate   func(a *IdentityAssertion)
		wantCode string // "" = nothing reported
	}{
		"key this agent never pinned": {
			setup:    func(_ *testing.T, _ *identitySeams, h *Heartbeat) { h.config.PinnedManifestPubKeys = nil },
			wantCode: "unpinned_key",
		},
		"signature that does not verify": {
			mutate: func(a *IdentityAssertion) {
				canonical, _ := a.canonicalBytes()
				a.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(otherKey, canonical))
			},
			wantCode: "invalid",
		},
		"answer to an earlier beat (transient)": {
			setup: func(_ *testing.T, _ *identitySeams, h *Heartbeat) {
				older := strings.Repeat("f", 32)
				h.identitySync.nonce.Store(&older)
			},
		},
		"identity given up on": {
			setup: func(t *testing.T, s *identitySeams, _ *Heartbeat) {
				t.Setenv("BREEZE_ORG_ID", "")
				t.Setenv("BREEZE_SITE_ID", "")
				writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now.Add(-time.Hour), OrgID: identityTestOrgB, SiteID: identityTestSiteB, Attempts: identityRestartMaxAttempts})
			},
			wantCode: "gave_up",
		},
		"identity given up on under an environment override": {
			setup: func(t *testing.T, s *identitySeams, _ *Heartbeat) {
				t.Setenv("BREEZE_ORG_ID", identityTestOrgA)
				writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now.Add(-time.Hour), OrgID: identityTestOrgB, SiteID: identityTestSiteB, Attempts: identityRestartMaxAttempts})
			},
			wantCode: "env_override",
		},
		"cooldown before one more attempt (will retry)": {
			setup: func(t *testing.T, s *identitySeams, _ *Heartbeat) {
				writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now.Add(-time.Minute), OrgID: identityTestOrgB, SiteID: identityTestSiteB, Attempts: 1})
			},
		},
		"rollback in progress (will retry)": {
			setup: func(_ *testing.T, _ *identitySeams, h *Heartbeat) {
				rollback := &identityRollbackController{}
				rollback.active.Store(true)
				h.rollbackController = rollback
			},
		},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			s := withIdentitySeams(t, nil)
			h := identityTestHeartbeat()
			if tc.setup != nil {
				tc.setup(t, s, h)
			}
			a := goldenAssertion()
			if tc.mutate != nil {
				tc.mutate(a)
			}
			if h.applyIdentityAssertion(a) {
				t.Fatal("assertion unexpectedly accepted")
			}
			got := h.identityRejectionForBeat()
			if tc.wantCode == "" {
				if got != nil {
					t.Fatalf("reported %+v for a refusal that is retried", got)
				}
				return
			}
			want := IdentityAssertionRejection{Code: tc.wantCode, OrgID: identityTestOrgB, SiteID: identityTestSiteB}
			if got == nil || *got != want {
				t.Fatalf("rejection = %+v, want %+v", got, want)
			}
			if again := h.identityRejectionForBeat(); again != nil {
				t.Fatalf("one refusal reported on two beats: %+v", again)
			}
		})
	}
}

// Once given up on, each later assertion for that identity is refused again
// and reported again (the server stops signing for a while, then re-checks).
func TestGivenUpIdentityIsReportedEachTimeItIsReasserted(t *testing.T) {
	s := withIdentitySeams(t, nil)
	t.Setenv("BREEZE_ORG_ID", "")
	t.Setenv("BREEZE_SITE_ID", "")
	h := identityTestHeartbeat()
	writeIdentityTestMarker(t, s.markerPath, identityRestartMarker{RestartedAt: s.now.Add(-time.Hour), OrgID: identityTestOrgB, SiteID: identityTestSiteB, Attempts: identityRestartMaxAttempts})
	for i := 0; i < 2; i++ {
		if h.applyIdentityAssertion(goldenAssertion()) {
			t.Fatal("restarted for an identity given up on")
		}
		if got := h.identityRejectionForBeat(); got == nil || got.Code != "gave_up" {
			t.Fatalf("beat %d: rejection = %+v", i, got)
		}
	}
	if s.persisted.Load() != 0 {
		t.Fatalf("persisted an identity given up on: %d", s.persisted.Load())
	}
}

// The server reads these exact JSON keys (apps/api/src/routes/agents/schemas.ts).
func TestIdentityAssertionRejectionWireFormat(t *testing.T) {
	body, err := json.Marshal(HeartbeatPayload{IdentityAssertionRejection: &IdentityAssertionRejection{Code: "unpinned_key", OrgID: identityTestOrgB, SiteID: identityTestSiteB}})
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Rejection map[string]string `json:"identityAssertionRejection"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"code": "unpinned_key", "orgId": identityTestOrgB, "siteId": identityTestSiteB}
	if len(decoded.Rejection) != len(want) {
		t.Fatalf("identityAssertionRejection = %v, want %v", decoded.Rejection, want)
	}
	for k, v := range want {
		if decoded.Rejection[k] != v {
			t.Fatalf("identityAssertionRejection.%s = %q, want %q", k, decoded.Rejection[k], v)
		}
	}

	empty, err := json.Marshal(HeartbeatPayload{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(empty), "identityAssertionRejection") {
		t.Fatalf("an agent with nothing to report sent the field: %s", empty)
	}
}
