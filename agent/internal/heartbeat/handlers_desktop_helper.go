package heartbeat

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// spawnGuards holds a per-session mutex so that spawns into different Windows
// sessions can proceed in parallel. The sync.Map key is the target session ID
// string (or "" for auto-detect).
var spawnGuards sync.Map

const maxGUIUserUIDs = 64

// desktopStartSeq numbers desktop-start IPC commands so every invocation gets
// its own correlation id.
//
// start_desktop is deliberately exempt from the heartbeat's command dedup
// (#434) because the viewer legitimately re-invokes the same commandId across
// reconnects, and the command can arrive over both the WebSocket and the
// heartbeat response. Two invocations for one desktop session can therefore be
// in flight at once. While every invocation derived the same IPC id
// ("desk-"+sessionID), the second collided with the first inside
// Session.SendCommand and was rejected with ErrDuplicateCommand — the #434
// exemption and the duplicate guard were in direct conflict, and the caller
// then misreported a healthy helper as crashed (#3107).
var desktopStartSeq atomic.Uint64

// nextDesktopStartCommandID returns a per-invocation IPC correlation id for a
// desktop start. The desktop session id is kept in the string so helper-side
// logs stay greppable; the counter is what makes it collision-free.
func nextDesktopStartCommandID(desktopSessionID string) string {
	return fmt.Sprintf("desk-%s-%d", desktopSessionID, desktopStartSeq.Add(1))
}

// desktopStartRetryBackoff paces the gap between desktop-start attempts, so a
// retry cannot burn in the same millisecond as the attempt it is replacing. A
// var, not a const, so tests can shrink it; production never writes it after
// init.
//
// It buys the recv loop time to observe a socket that died between the two
// attempts and condemn the session, so helperSessionForTarget is not handed
// back the same corpse. It deliberately does NOT try to cover a frozen helper:
// that one is only condemned at the broker's 45s keepaliveTimeout, far beyond
// any backoff worth blocking a start on.
var desktopStartRetryBackoff = time.Second

// desktopStartCommandTimeout bounds one desktop-start IPC round-trip. A var,
// not a const, so tests can shrink it; production never writes it after init.
var desktopStartCommandTimeout = 30 * time.Second

// desktopStartCall is one in-flight desktop start that later callers for the
// same desktop session wait on. result is written before done is closed, so a
// reader that has received from done sees it safely.
type desktopStartCall struct {
	done   chan struct{}
	result tools.CommandResult
}

// desktopStartInflight maps a desktop session id to its in-flight
// desktopStartCall.
var desktopStartInflight sync.Map

// joinOrRunDesktopStart collapses concurrent start_desktop invocations for one
// desktop session onto a single helper round-trip.
//
// This is the other half of the #3107 fix, and it is load-bearing. Giving each
// invocation its own IPC id stops the self-collision, but it also removes the
// thing that was accidentally serialising these calls: the ErrDuplicateCommand
// rejection. Without a guard here, both invocations would reach the helper, and
// SessionManager.StartSession (remote/desktop/session_webrtc.go) unconditionally
// stops EVERY existing session before registering the new one — so the second
// start tears down the first, both callers are told "completed", and only one
// peer connection is live. Worse, the first session's OnConnectionStateChange
// closure captures the session id rather than the *Session, so its late
// Closed callback calls StopSession(sessionID) and kills the SECOND session,
// firing a spurious desktop_peer_disconnected.
//
// The joiner takes the leader's result — "join or defer to it", as the issue
// asked. That is unconditionally right for the #3107 case, which is ONE
// start_desktop delivered over both the WebSocket and the heartbeat response:
// same command id, same offer, so the leader's answer is the joiner's answer.
//
// It is deliberately not conditioned on the offers matching. A concurrent start
// carrying a DIFFERENT offer for the same desktop session is not reachable in
// practice — the viewer retries the same offer under the same commandId
// (heartbeat.go, #434), and a genuine renegotiation only follows a completed or
// failed attempt, sequentially. Deferring such a caller to a second turn instead
// would cost real correctness: leases are keyed per desktop session
// (desktopLeaseOpID), so the leader's failure path releases the shared lease out
// from under the deferred caller, which then streams unleased and gets its
// helper reaped mid-session. A bounded wrong-SDP failure beats that, and beats
// today's behaviour, where such a caller is rejected outright.
func (h *Heartbeat) joinOrRunDesktopStart(sessionID string, run func() tools.CommandResult) tools.CommandResult {
	call := &desktopStartCall{done: make(chan struct{})}
	// Pre-set so a panic in run() cannot hand joiners a zero-valued result
	// (Status "", no Error), which upstream would submit to the API as a
	// command result with no failure text. Overwritten on the normal path.
	call.result = tools.NewErrorResult(
		fmt.Errorf("desktop start for session %s did not complete", sessionID), 0)

	existing, loaded := desktopStartInflight.LoadOrStore(sessionID, call)
	if !loaded {
		// Released via defer: if run() panics, the entry must still be dropped
		// and done still closed, or every later start for this desktop session
		// blocks forever on a leader that will never finish. The panic itself
		// still propagates.
		defer func() {
			desktopStartInflight.Delete(sessionID)
			close(call.done)
		}()
		call.result = run()
		return call.result
	}

	leader := existing.(*desktopStartCall)
	log.Info("joining a desktop start already in flight for this session", "sessionId", sessionID)
	select {
	case <-leader.done:
		return leader.result
	case <-h.stopChan:
		return tools.NewErrorResult(
			fmt.Errorf("desktop start aborted during shutdown while waiting on an in-flight start for session %s", sessionID), 0)
	}
}

// ErrLinuxDesktopHelperUnsupported is returned by spawnHelperForDesktop on
// Linux (and any other non-darwin/non-windows GOOS) until a real Linux
// desktop-helper spawn branch exists (Phase 2 of the Linux remote-desktop
// plan). findOrSpawnHelper treats it as terminal — there is nothing to poll for.
var ErrLinuxDesktopHelperUnsupported = errors.New("linux desktop-helper not yet supported")

// sessionSpawnMu returns a mutex for the given session key, creating one if needed.
func sessionSpawnMu(sessionKey string) *sync.Mutex {
	val, _ := spawnGuards.LoadOrStore(sessionKey, &sync.Mutex{})
	return val.(*sync.Mutex)
}

// isWinSessionDisconnected checks whether the given Windows session ID is
// disconnected (no active display). Helpers in disconnected sessions cannot
// capture the screen. Returns false on non-Windows or if the state can't be
// determined.
func isWinSessionDisconnected(winSessionID string) bool {
	if winSessionID == "" || winSessionID == "0" {
		return false
	}
	return sessionbroker.IsSessionDisconnected(winSessionID)
}

func (h *Heartbeat) helperSessionForTarget(targetSession string) *sessionbroker.Session {
	if h.helperFinder != nil {
		return h.helperFinder(targetSession)
	}
	return h.findOrSpawnHelper(targetSession)
}

func (h *Heartbeat) spawnDesktopHelper(targetSession string) error {
	if h.spawnHelper != nil {
		return h.spawnHelper(targetSession)
	}
	return h.spawnHelperForDesktop(targetSession)
}

func (h *Heartbeat) rememberDesktopOwner(desktopSessionID, helperSessionID string) {
	if desktopSessionID == "" || helperSessionID == "" {
		return
	}
	h.desktopOwners.Store(desktopSessionID, helperSessionID)
}

func (h *Heartbeat) forgetDesktopOwner(desktopSessionID string) {
	if desktopSessionID == "" {
		return
	}
	h.desktopOwners.Delete(desktopSessionID)
}

func (h *Heartbeat) desktopOwnerSession(desktopSessionID string) *sessionbroker.Session {
	if desktopSessionID == "" || h.sessionBroker == nil {
		return nil
	}
	helperSessionID, ok := h.desktopOwners.Load(desktopSessionID)
	if !ok {
		return nil
	}
	helperSessionIDStr, ok := helperSessionID.(string)
	if !ok || helperSessionIDStr == "" {
		return nil
	}
	return h.sessionBroker.SessionByID(helperSessionIDStr)
}

// startDesktopViaHelper routes a desktop start request through the IPC user helper.
// If the helper crashes during the request, it automatically respawns and retries.
// On macOS, it pre-checks TCC Screen Recording permission and returns a clear error
// if the required permissions haven't been configured yet.
func (h *Heartbeat) startDesktopViaHelper(sessionID, offer string, iceServers []desktop.ICEServerConfig, displayIndex int, policy desktop.SessionPolicy, payload map[string]any) tools.CommandResult {
	// Log TCC status for diagnostics but don't gate — the cached status may be
	// stale (e.g. permission just granted). Let the capturer attempt and fail
	// with the real error instead of blocking on a potentially outdated check.
	if runtime.GOOS == "darwin" && h.sessionBroker != nil {
		if tccStatus := h.sessionBroker.TCCStatus(); tccStatus != nil && !tccStatus.ScreenRecording {
			log.Warn("TCC Screen Recording not yet reported as granted — attempting capture anyway",
				"screenRecording", tccStatus.ScreenRecording,
				"fullDiskAccess", tccStatus.FullDiskAccess,
			)
		}
	}

	// Read optional target Windows session ID from payload
	targetSession := ""
	if ts, ok := payload["targetSessionId"].(float64); ok {
		targetSession = fmt.Sprintf("%d", int(ts))
	}

	// Read optional GPU vendor hint from payload (set by API from device hardware inventory)
	gpuVendor := ""
	if v, ok := payload["gpuVendor"].(string); ok {
		gpuVendor = v
	}

	// Marshal ICE servers once (used across retries)
	var iceRaw json.RawMessage
	if len(iceServers) > 0 {
		data, err := json.Marshal(iceServers)
		if err != nil {
			return tools.NewErrorResult(fmt.Errorf("failed to marshal ICE servers: %w", err), 0)
		}
		iceRaw = data
	}

	clipHostToViewer := policy.ClipboardHostToViewer
	clipViewerToHost := policy.ClipboardViewerToHost
	req := ipc.DesktopStartRequest{
		SessionID:               sessionID,
		Offer:                   offer,
		ICEServers:              iceRaw,
		DisplayIndex:            displayIndex,
		GPUVendor:               gpuVendor,
		ClipboardHostToViewer:   &clipHostToViewer,
		ClipboardViewerToHost:   &clipViewerToHost,
		IdleTimeoutMinutes:      int(policy.IdleTimeout / time.Minute),
		MaxSessionDurationHours: int(policy.MaxDuration / time.Hour),
	}

	// Only one start may be in flight per desktop session — see
	// joinOrRunDesktopStart for why the helper cannot tolerate two.
	return h.joinOrRunDesktopStart(sessionID, func() tools.CommandResult {
		// On-demand (RDS) hosts bypass find-or-spawn entirely: handleStartDesktop
		// already leased the target session's helper, so the only thing left is to
		// wait for the lifecycle manager to bring it up. Strict by design (#434) —
		// no fallback to another session.
		if h.lifecycleMode() == "on-demand" {
			return h.startDesktopOnDemand(sessionID, targetSession, req)
		}
		return h.startDesktopAlwaysOn(sessionID, targetSession, req)
	})
}

// startDesktopAlwaysOn drives the always-on helper path: find a capable helper,
// run the start, and retry once if the helper session dies mid-command.
//
// Retry up to 2 times: if the helper session dies during SendCommand, respawn
// and retry instead of failing back to the API (which adds 20-30s of round-trip
// delay). Only a genuine session death is retried here — see
// startDesktopOnSession — and retries are spaced by desktopStartRetryBackoff so
// the second attempt is not simply the first one repeated in the same
// millisecond against the same session (#3107).
func (h *Heartbeat) startDesktopAlwaysOn(sessionID, targetSession string, req ipc.DesktopStartRequest) tools.CommandResult {
	const maxAttempts = 2
	lastError := ""
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 && !h.waitBeforeDesktopRetry() {
			return tools.NewErrorResult(fmt.Errorf("desktop start aborted during shutdown after %d attempt(s): %s", attempt, lastError), 0)
		}

		session := h.helperSessionForTarget(targetSession)
		if session == nil {
			// Carry lastError: on the retry pass the reason the FIRST helper
			// went away is the actionable half of this failure, and it would
			// otherwise survive only in a log line.
			if lastError != "" {
				return tools.NewErrorResult(
					fmt.Errorf("no capable helper available after spawn attempt (previous attempt failed: %s)", lastError), 0)
			}
			return tools.NewErrorResult(fmt.Errorf("no capable helper available after spawn attempt"), 0)
		}

		result, helperDied := h.startDesktopOnSession(session, sessionID, req)
		if helperDied {
			lastError = result.Error
			log.Warn("IPC desktop start failed, will retry with new helper",
				"attempt", attempt+1,
				"error", result.Error,
				"session", session.SessionID,
			)
			continue
		}
		return result
	}

	// Every attempt lost its helper session mid-command. Say that, and carry the
	// real error — "helper keeps crashing" with no detail was reported for
	// failures that had nothing to do with a crash (#3107).
	return tools.NewErrorResult(
		fmt.Errorf("desktop start failed after %d attempts (helper session dropped each time): %s", maxAttempts, lastError), 0)
}

// waitBeforeDesktopRetry sleeps desktopStartRetryBackoff between desktop-start
// attempts. It returns false when the agent is shutting down, so a pending
// retry does not hold shutdown open. A nil stopChan (tests) simply waits out
// the backoff.
func (h *Heartbeat) waitBeforeDesktopRetry() bool {
	if desktopStartRetryBackoff <= 0 {
		return true
	}
	timer := time.NewTimer(desktopStartRetryBackoff)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-h.stopChan:
		return false
	}
}

// desktopStartLostHelper reports whether a Session.SendCommand failure means
// the helper session went away — the only class of failure that a retry
// against a freshly spawned helper can fix.
//
// Before #3107 every SendCommand error was reported as a helper death, so a
// perfectly healthy helper was blamed for a crash it never had. Two errors are
// raised by a session that is still connected and must never be counted as one:
//
//   - ErrDuplicateCommand — another start for this desktop session is already
//     in flight. Nothing has crashed and a retry cannot help. Unreachable now
//     that each invocation carries its own id, kept as a guard against a future
//     caller reintroducing a shared one.
//   - ErrCommandTimeout — the command budget elapsed while the session was
//     still registered. A helper process that actually dies closes the
//     session's done channel and surfaces as "session closed while waiting for
//     response", not as a timeout, so this is the alive-but-slow-or-frozen
//     case. Note it is NOT proof of liveness: a frozen helper holds its socket
//     open until the broker's 45s keepaliveTimeout, which outlasts this budget.
//     Terminal either way, because helperSessionForTarget does no liveness or
//     pong-age check and would hand the retry back the very same session.
//
// Anything else (a failed socket write, a session closed under us) is a real
// transport failure, so the default stays "the helper is gone, retry".
func desktopStartLostHelper(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, sessionbroker.ErrDuplicateCommand) || errors.Is(err, sessionbroker.ErrCommandTimeout) {
		return false
	}
	return true
}

// startDesktopOnSession runs one desktop-start attempt against a specific
// helper session. The second return value is true only when the helper session
// itself went away mid-command, as classified by desktopStartLostHelper — the
// always-on path treats that as worth retrying against a freshly spawned
// helper; every other failure is terminal and must be surfaced verbatim.
func (h *Heartbeat) startDesktopOnSession(session *sessionbroker.Session, sessionID string, req ipc.DesktopStartRequest) (tools.CommandResult, bool) {
	resp, err := session.SendCommand(nextDesktopStartCommandID(sessionID), ipc.TypeDesktopStart, req, desktopStartCommandTimeout)
	if err != nil {
		lostHelper := desktopStartLostHelper(err)
		// Terminal failures reach the technician verbatim (agentWs writes the
		// text into remote_sessions.errorMessage and the viewer shows it), so
		// the two sentinels must not surface as bare internal strings.
		switch {
		case errors.Is(err, sessionbroker.ErrCommandTimeout):
			// NOTE: SendCommand's timeout does not cancel helper-side work, so
			// the helper may still bring up a capture that nothing here owns.
			// It is deliberately NOT reaped with a compensating desktop_stop:
			// the helper processes stop off StartSession's mutex, so a stop
			// still queued behind a wedged helper would land after the viewer's
			// next start and silently kill a session the daemon believes is
			// live — the same class of bug this issue is about. The orphan is
			// self-limiting instead: the viewer never gets an answer, ICE never
			// completes, and the peer connection tears itself down on the 15s
			// failed timeout. Reaping it safely needs a helper-side start
			// generation so a stale stop cannot match a newer session; tracked
			// on #3107 with the ownership-on-failure gap.
			err = fmt.Errorf("desktop helper did not answer the start request within %s (helper session %s, windows session %s) — the helper is busy or frozen; retry, and restart the Breeze helper on the device if it repeats: %w",
				desktopStartCommandTimeout, session.SessionID, session.WinSessionID, err)
		case errors.Is(err, sessionbroker.ErrDuplicateCommand):
			err = fmt.Errorf("another desktop start is already in flight for session %s on helper %s — the helper is healthy; this is a Breeze bug, please report it: %w",
				sessionID, session.SessionID, err)
		}
		return tools.NewErrorResult(err, 0), lostHelper
	}
	if resp.Error != "" {
		return tools.CommandResult{
			Status: "failed",
			Error:  resp.Error,
		}, false
	}

	var dResp ipc.DesktopStartResponse
	if err := json.Unmarshal(resp.Payload, &dResp); err != nil {
		return tools.NewErrorResult(fmt.Errorf("failed to unmarshal desktop start response: %w", err), 0), false
	}
	h.rememberDesktopOwner(sessionID, session.SessionID)

	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"answer":    dResp.Answer,
	}, 0), false
}

// startDesktopOnDemand is the on-demand (RDS) desktop start: wait for the
// leased system-role helper in the pinned session, then drive the start
// against exactly that helper. A non-ready wait surfaces the typed reason
// rather than a bare timeout, and never substitutes another session (#434).
func (h *Heartbeat) startDesktopOnDemand(sessionID, targetSession string, req ipc.DesktopStartRequest) tools.CommandResult {
	lc := h.lifecycleController()
	if lc == nil {
		return tools.NewErrorResult(errors.New("helper lifecycle manager is not running"), 0)
	}
	winID, err := resolveDesktopTargetWinID(targetSession)
	if err != nil {
		h.releaseDesktopLeases(sessionID)
		h.takeDesktopTarget(sessionID)
		return tools.NewErrorResult(err, 0)
	}

	waitCtx, cancelWait := context.WithTimeout(context.Background(), helperReadyBudget)
	res := lc.WaitForHelperReady(waitCtx, sessionbroker.HelperKey{WindowsSessionID: winID, Role: ipc.HelperRoleSystem})
	cancelWait()
	if res.Status != sessionbroker.HelperWaitReady {
		log.Warn("on-demand desktop helper never became ready",
			"sessionId", sessionID, "winSession", winID, "status", string(res.Status))
		h.releaseDesktopLeases(sessionID)
		h.takeDesktopTarget(sessionID)
		return tools.NewErrorResult(errors.New(helperWaitFailureMessage(res)), 0)
	}

	// No retry loop here: a helper that dies mid-start is respawned by the
	// lifecycle reconciler under the lease we still hold, and retrying against
	// a different session is exactly what strict targeting forbids.
	result, _ := h.startDesktopOnSession(res.Session, sessionID, req)
	if result.Status == "failed" {
		h.releaseDesktopLeases(sessionID)
		h.takeDesktopTarget(sessionID)
		return result
	}
	h.startDesktopLeaseRenewal(sessionID)
	return result
}

// findActiveHelper looks up a capable helper for the target session, applying
// macOS preference and preferring the console session on Windows. If the best
// session is disconnected, iterates all capable sessions looking for a
// non-disconnected one (preferring the console). Falls back to a disconnected
// session only when allowDisconnected is true.
func (h *Heartbeat) findActiveHelper(targetSession string, allowDisconnected ...bool) *sessionbroker.Session {
	session := h.sessionBroker.FindCapableSession("capture", targetSession)
	if runtime.GOOS == "darwin" {
		if preferred := h.sessionBroker.PreferredDesktopSession(); preferred != nil {
			session = preferred
		}
	}
	if targetSession != "" && session != nil && session.WinSessionID != targetSession {
		session = nil
	}

	// Issue #434: on Windows, if the caller pinned a target WTS session and we
	// can't find a helper for it, check whether the target session still exists
	// at the OS level. If it's gone (user logout tore it down), substitute any
	// capable helper so the viewer attaches to the new loginwindow / console
	// instead of endlessly retrying a vanished session. Logged at warn so we
	// can see the substitution in the shipper.
	if session == nil && targetSession != "" && runtime.GOOS == "windows" {
		if !winSessionStillExists(targetSession) {
			log.Warn("findActiveHelper: target WTS session no longer exists, falling back to any capable helper",
				"targetSession", targetSession)
			return h.findActiveHelper("", allowDisconnected...)
		}
	}

	// On Windows with no target specified, prefer the console session and
	// avoid disconnected sessions. The console is the physical display and
	// should always be the first pick; the viewer shows RDP sessions to
	// switch to if needed.
	if session != nil && targetSession == "" && runtime.GOOS == "windows" {
		consoleID := sessionbroker.GetConsoleSessionID()

		// If the best session IS the console and it's not disconnected, use it.
		// Hot path — fires on every start_desktop. Info-level; flip
		// `desktop_debug: true` in agent.yaml to ship. The "alternative",
		// "fallback", and "falling through" branches below remain at warn
		// because they're the interesting cases.
		if session.WinSessionID == consoleID && !isWinSessionDisconnected(session.WinSessionID) {
			log.Info("findActiveHelper: picked console session directly",
				"winSession", session.WinSessionID, "helperSession", session.SessionID,
				"consoleID", consoleID)
			return session
		}

		// Otherwise, look for a better alternative among all capable sessions.
		if alternatives := h.sessionBroker.SessionsWithScope("desktop"); len(alternatives) > 0 {
			var consoleAlt, nonDisconnectedAlt *sessionbroker.Session
			altSummaries := make([]string, 0, len(alternatives))
			for _, alt := range alternatives {
				caps := alt.GetCapabilities()
				canCapture := caps != nil && caps.CanCapture
				altSummaries = append(altSummaries,
					fmt.Sprintf("{win=%s disc=%v cap=%v}",
						alt.WinSessionID, isWinSessionDisconnected(alt.WinSessionID), canCapture))
				if !canCapture {
					continue
				}
				// Console session is always preferred
				if alt.WinSessionID == consoleID && consoleAlt == nil {
					consoleAlt = alt
				}
				if !isWinSessionDisconnected(alt.WinSessionID) && nonDisconnectedAlt == nil {
					nonDisconnectedAlt = alt
				}
			}
			if consoleAlt != nil && !isWinSessionDisconnected(consoleAlt.WinSessionID) {
				log.Warn("findActiveHelper: picked console alternative",
					"winSession", consoleAlt.WinSessionID, "helperSession", consoleAlt.SessionID,
					"consoleID", consoleID, "firstPick", session.WinSessionID,
					"alternatives", strings.Join(altSummaries, ","))
				return consoleAlt
			}
			if nonDisconnectedAlt != nil {
				log.Warn("findActiveHelper: picked non-disconnected alternative (no live console helper)",
					"winSession", nonDisconnectedAlt.WinSessionID, "helperSession", nonDisconnectedAlt.SessionID,
					"consoleID", consoleID, "firstPick", session.WinSessionID,
					"alternatives", strings.Join(altSummaries, ","))
				return nonDisconnectedAlt
			}
			// Console is disconnected but exists — prefer it over other disconnected sessions
			if consoleAlt != nil {
				if len(allowDisconnected) > 0 && allowDisconnected[0] {
					log.Warn("findActiveHelper: picked disconnected console as last resort",
						"winSession", consoleAlt.WinSessionID, "consoleID", consoleID)
					return consoleAlt
				}
				return nil
			}
		}

		// Original session is disconnected, no alternatives found
		if isWinSessionDisconnected(session.WinSessionID) {
			if len(allowDisconnected) == 0 || !allowDisconnected[0] {
				return nil
			}
		}
		log.Warn("findActiveHelper: falling through to first-pick session",
			"winSession", session.WinSessionID, "helperSession", session.SessionID,
			"consoleID", consoleID)
	}
	return session
}

// winSessionStillExists probes WTS to determine whether the given Windows
// session ID is still enumerated by the OS. Used to distinguish "helper hasn't
// spawned yet in this session" (retry worthwhile) from "session has been torn
// down by logout" (retry futile — substitute a different helper). On non-Windows
// or on probe failure, returns true as a conservative default so we don't
// over-substitute. Issue #434.
func winSessionStillExists(targetSession string) bool {
	if runtime.GOOS != "windows" || targetSession == "" {
		return true
	}
	detector := sessionbroker.NewSessionDetector()
	sessions, err := detector.ListSessions()
	if err != nil {
		// Conservative default: if the probe fails we claim the session
		// still exists so we don't aggressively substitute. But log it at
		// warn so the operator can see the substitution safety net has
		// been silently disabled — otherwise a reliably-failing probe
		// looks identical to a genuinely-live session.
		log.Warn("winSessionStillExists: WTS probe failed, assuming session still exists (#434 safety net disabled for this call)",
			"targetSession", targetSession,
			"error", err.Error())
		return true
	}
	for _, s := range sessions {
		if s.Session == targetSession {
			return true
		}
	}
	return false
}

// findOrSpawnHelper locates a capable helper session, spawning one if needed.
func (h *Heartbeat) findOrSpawnHelper(targetSession string) *sessionbroker.Session {
	session := h.findActiveHelper(targetSession)

	// Log when an existing helper is in a disconnected Windows session.
	if session == nil {
		if candidate := h.sessionBroker.FindCapableSession("capture", targetSession); candidate != nil && targetSession == "" && isWinSessionDisconnected(candidate.WinSessionID) {
			log.Warn("helper is in a disconnected Windows session, will try spawning new helper first",
				"helperSession", candidate.SessionID,
				"winSession", candidate.WinSessionID)
		}
	}

	if session != nil {
		return session
	}

	// Serialize spawns per target session
	mu := sessionSpawnMu(targetSession)
	mu.Lock()
	defer mu.Unlock()

	// Re-check after lock
	if session = h.findActiveHelper(targetSession); session != nil {
		return session
	}

	if err := h.spawnDesktopHelper(targetSession); err != nil {
		log.Warn("helper spawn failed", "error", err.Error())
		if errors.Is(err, ErrLinuxDesktopHelperUnsupported) {
			// Terminal: no helper can ever connect on this platform yet, so the
			// 10s poll and disconnected-session fallback are pointless.
			return nil
		}
		// Don't give up yet — fall through to disconnected-session fallback below.
	}

	// Poll for the helper to connect (up to 10s)
	for i := 0; i < 100; i++ {
		time.Sleep(100 * time.Millisecond)
		if session = h.findActiveHelper(targetSession); session != nil {
			return session
		}
	}

	// Last resort: accept a helper in a disconnected Windows session.
	// GDI/fallback capture can still work in disconnected sessions, and this
	// is common on cloud VMs (e.g. DigitalOcean) where RDP is not always active.
	if targetSession == "" {
		if session = h.findActiveHelper(targetSession, true); session != nil {
			log.Info("using helper in disconnected Windows session as fallback",
				"helperSession", session.SessionID,
				"winSession", session.WinSessionID)
			return session
		}
	}

	// Distinguish between helper not connecting at all vs connecting but lacking capture capability
	// (e.g. TCC Screen Recording not granted on macOS).
	if h.sessionBroker != nil {
		if desktopSessions := h.sessionBroker.SessionsWithScope("desktop"); len(desktopSessions) > 0 {
			log.Warn("helper connected but CanCapture is false — check Screen Recording permission (macOS) or session state (Windows)",
				"targetSession", targetSession,
				"connectedHelpers", len(desktopSessions),
			)
			return nil
		}
	}
	log.Warn("helper spawned but did not connect within 10s", "targetSession", targetSession)
	return nil
}

// darwinHelperPlists defines the LaunchAgent plists the agent writes to disk
// when they're missing, so the desktop helper self-configures without a .pkg.
var darwinHelperPlists = map[string]string{
	"/Library/LaunchAgents/com.breeze.desktop-helper-user.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.desktop-helper-user</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>user_session</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>Aqua</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`,
	"/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist": `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.breeze.desktop-helper-loginwindow</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/breeze-desktop-helper</string>
        <string>--context</string>
        <string>login_window</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>LimitLoadToSessionType</key>
    <string>LoginWindow</string>
    <key>StandardOutPath</key>
    <string>/dev/null</string>
    <key>StandardErrorPath</key>
    <string>/dev/null</string>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
`,
}

// ensureDarwinHelperPlists writes any missing LaunchAgent plists to disk.
// The agent runs as root so it can write to /Library/LaunchAgents/.
func ensureDarwinHelperPlists() {
	if runtime.GOOS != "darwin" {
		return
	}
	for path, content := range darwinHelperPlists {
		if _, err := os.Stat(path); err == nil {
			continue // already exists
		}
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			log.Warn("failed to write helper plist", "path", path, "error", err.Error())
		} else {
			log.Info("installed helper LaunchAgent plist", "path", path)
		}
	}
}

// spawnHelperForDesktop spawns a user helper in the target session.
// If targetSession is empty, it auto-detects the first active non-services session.
func (h *Heartbeat) spawnHelperForDesktop(targetSession string) error {
	if runtime.GOOS == "darwin" {
		// Ensure LaunchAgent plists exist on disk before any kickstart/bootstrap.
		ensureDarwinHelperPlists()

		if uids := findGUIUserUIDs(); len(uids) > 0 {
			bootstrapped := false
			for _, uid := range uids {
				domain := "gui/" + uid
				label := domain + "/com.breeze.desktop-helper-user"
				// kickstart -k kills any existing instance and restarts it.
				if err := exec.Command("launchctl", "kickstart", "-k", label).Run(); err == nil {
					log.Info("kickstarted desktop helper LaunchAgent", "uid", uid)
					return nil // let the caller's poll loop wait for the connection
				} else {
					log.Warn("launchctl kickstart failed, trying bootstrap",
						"uid", uid, "label", label, "error", err.Error())
				}
				// Fallback: try bootstrap in case the plist was never loaded.
				if err := exec.Command("launchctl", "bootstrap", domain,
					"/Library/LaunchAgents/com.breeze.desktop-helper-user.plist").Run(); err != nil {
					log.Warn("launchctl bootstrap also failed",
						"uid", uid, "domain", domain, "error", err.Error())
				} else {
					log.Info("bootstrapped desktop helper LaunchAgent", "uid", uid, "domain", domain)
					bootstrapped = true
				}
			}
			if bootstrapped {
				return nil // let the caller's poll loop wait for the connection
			}
		}
		if err := exec.Command("launchctl", "kickstart", "-k", "loginwindow/com.breeze.desktop-helper-loginwindow").Run(); err == nil {
			log.Info("kickstarted login-window desktop helper LaunchAgent")
			return nil
		}
		// Fallback: try bootstrap in case the plist was never loaded into the loginwindow domain.
		const loginwindowPlist = "/Library/LaunchAgents/com.breeze.desktop-helper-loginwindow.plist"
		if err := exec.Command("launchctl", "bootstrap", "loginwindow", loginwindowPlist).Run(); err == nil {
			log.Info("bootstrapped login-window desktop helper LaunchAgent")
			return nil
		} else {
			log.Warn("launchctl bootstrap loginwindow also failed", "error", err.Error())
		}
		return fmt.Errorf("no desktop-helper connected; ensure the LaunchAgents are loaded")
	}

	if runtime.GOOS != "windows" {
		// Linux (and any other non-darwin GOOS): no desktop-helper binary is
		// shipped yet. Phase 2 replaces this with a loginctl-based per-session
		// spawn. Return a terminal sentinel so findOrSpawnHelper does not waste
		// 10s polling for a helper that can never connect.
		return ErrLinuxDesktopHelperUnsupported
	}

	if targetSession == "" {
		// Prefer the physical console session (WTSGetActiveConsoleSessionId).
		// This avoids spawning into a disconnected RDP session.
		consoleID := sessionbroker.GetConsoleSessionID()

		detector := sessionbroker.NewSessionDetector()
		detected, err := detector.ListSessions()
		if err != nil {
			return fmt.Errorf("failed to list sessions: %w", err)
		}

		var consoleFallback, activeFallback, connectedFallback, disconnectedFallback string
		for _, ds := range detected {
			if ds.Type == "services" {
				continue
			}
			// Console session is always preferred regardless of state —
			// it's the physical display and should be the first pick.
			if ds.Session == consoleID && consoleFallback == "" {
				consoleFallback = ds.Session
			}
			if ds.State == "active" && activeFallback == "" {
				activeFallback = ds.Session
			}
			if ds.State == "connected" && connectedFallback == "" {
				connectedFallback = ds.Session
			}
			if ds.State == "disconnected" && disconnectedFallback == "" {
				disconnectedFallback = ds.Session
			}
		}

		// Priority: console > any active > any connected > disconnected (last resort)
		switch {
		case consoleFallback != "":
			targetSession = consoleFallback
		case activeFallback != "":
			targetSession = activeFallback
		case connectedFallback != "":
			targetSession = connectedFallback
		case disconnectedFallback != "":
			log.Info("no active/connected session found, using disconnected session as fallback",
				"session", disconnectedFallback)
			targetSession = disconnectedFallback
		default:
			return fmt.Errorf("no non-services session found (active, connected, or disconnected)")
		}
	}

	_, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(targetSession)
	if err != nil {
		return fmt.Errorf("invalid session ID %q: %w", targetSession, err)
	}
	return fmt.Errorf("no lifecycle-owned helper is connected for Windows session %s; waiting for lifecycle reconciliation", targetSession)
}

// findGUIUserUIDs returns the UIDs of users with a loginwindow process (macOS).
// Used to kickstart the helper LaunchAgent.
func findGUIUserUIDs() []string {
	if runtime.GOOS != "darwin" {
		return nil
	}
	out, err := exec.Command("ps", "-axo", "uid=,comm=").Output()
	if err != nil {
		log.Warn("failed to list processes for GUI user detection", "error", err.Error())
		return nil
	}
	return parseGUIUserUIDs(string(out))
}

// KickstartDesktopHelpers restarts the macOS desktop helper LaunchAgents so they
// re-evaluate TCC permissions. Exported for the daemon's TCC auto-grant retry
// path (main): once the user grants Full Disk Access, the daemon writes the
// Screen Recording + Accessibility grants, but already-running helpers cached the
// old denied state and need a restart to pick them up.
func KickstartDesktopHelpers() {
	kickstartDarwinDesktopHelpers()
}

// kickstartDarwinDesktopHelpers re-kickstarts the macOS desktop helper
// LaunchAgents for every logged-in GUI user session. This is called after a
// self-update restart to force helpers to reconnect to the new IPC socket
// immediately instead of waiting for their reconnect backoff.
func kickstartDarwinDesktopHelpers() {
	if runtime.GOOS != "darwin" {
		return
	}
	ensureDarwinHelperPlists()

	uids := findGUIUserUIDs()
	for _, uid := range uids {
		label := "gui/" + uid + "/com.breeze.desktop-helper-user"
		if err := exec.Command("launchctl", "kickstart", "-k", label).Run(); err != nil {
			log.Warn("post-update: launchctl kickstart failed",
				"uid", uid, "label", label, "error", err.Error())
		} else {
			log.Info("post-update: kickstarted desktop helper", "uid", uid)
		}
	}

	// Also kickstart the login-window helper.
	if err := exec.Command("launchctl", "kickstart", "-k",
		"loginwindow/com.breeze.desktop-helper-loginwindow").Run(); err != nil {
		log.Warn("post-update: launchctl kickstart login-window helper failed",
			"error", err.Error())
	} else {
		log.Info("post-update: kickstarted login-window desktop helper")
	}
}

func parseGUIUserUIDs(output string) []string {
	seen := map[string]bool{}
	var uids []string
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		uid, comm := fields[0], fields[len(fields)-1]
		// Skip root (uid 0) — its loginwindow process is the system login UI,
		// not a GUI user session. Bootstrapping into gui/0 always fails (exit 125).
		if uid == "0" {
			continue
		}
		if _, err := sessionbroker.ParseWindowsSessionIDForHeartbeat(uid); err != nil {
			continue
		}
		if strings.HasSuffix(comm, "loginwindow") && !seen[uid] {
			seen[uid] = true
			uids = append(uids, uid)
			if len(uids) >= maxGUIUserUIDs {
				break
			}
		}
	}
	return uids
}
