package heartbeat

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// SEC-038 W05 — the agent half of the fence resync.
//
// The durable fence (desktop_fence.go) refuses a generation-carrying start for
// any session it has not confirmed with the control plane IN THIS PROCESS.
// This file is that confirmation: a plain revocation_lease_renew carrying a
// correlating nonce, whose answer the API now decorates with the session's
// current start generation and termination phase. No new endpoint, and the
// same authorization recheck the lease already performs.

// defaultDesktopFenceSyncTimeout bounds the resync round trip. Deliberately
// short: the viewer waits ~15 s for an SDP answer, and everything after
// admission (helper spawn, consent, capture, encode) has to fit in what is
// left. A resync that has not answered in this long is an outage, and an
// outage means refuse — the start will be retried by the operator.
const defaultDesktopFenceSyncTimeout = 4 * time.Second

func (h *Heartbeat) fenceSyncTimeout() time.Duration {
	if h.desktopFenceSyncTimeout > 0 {
		return h.desktopFenceSyncTimeout
	}
	return defaultDesktopFenceSyncTimeout
}

// newFenceSyncNonce returns an opaque correlator. Uniqueness is all that is
// required — it is echoed by the server and never trusted for anything else.
func newFenceSyncNonce() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// Extremely unlikely; a time-based fallback is still unique enough for
		// the purpose (distinguishing this process's in-flight attempts).
		return "t" + time.Now().Format("20060102150405.000000000")
	}
	return hex.EncodeToString(b[:])
}

// syncDesktopFence performs one bounded resync for sessionID and reports
// whether the control plane answered. A false return means the caller must
// refuse the start: no answer is not a permission.
func (h *Heartbeat) syncDesktopFence(sessionID string) bool {
	h.mu.Lock()
	request := h.leaseSyncRequester
	h.mu.Unlock()
	if request == nil {
		request = h.requestRevocationLeaseSync
	}

	nonce := newFenceSyncNonce()
	// Register BEFORE sending: an answer that beats the subscribe would
	// otherwise be missed and time the start out.
	ch := h.desktopStartFence.subscribeSync(sessionID, nonce)
	defer h.desktopStartFence.unsubscribeSync(sessionID, ch)

	if err := request(sessionID, nonce); err != nil {
		log.Warn("desktop fence resync could not be sent",
			"sessionId", sessionID, "error", err.Error())
		return false
	}

	timer := time.NewTimer(h.fenceSyncTimeout())
	defer timer.Stop()
	select {
	case outcome := <-ch:
		if outcome == desktopFenceSyncUnavailable {
			log.Warn("desktop fence resync unavailable; refusing the start",
				"sessionId", sessionID)
			return false
		}
		return true
	case <-timer.C:
		log.Warn("desktop fence resync timed out; refusing the start",
			"sessionId", sessionID, "timeout", h.fenceSyncTimeout().String())
		return false
	}
}

// errNoCommandSocket — with no command socket there is no control plane to
// ask, so a start for an unknown session cannot be admitted.
var errNoCommandSocket = errors.New("no command socket to resync the desktop start fence")

// requestRevocationLeaseSync is the production transport for a resync.
func (h *Heartbeat) requestRevocationLeaseSync(sessionID, nonce string) error {
	if h.wsClient == nil {
		return errNoCommandSocket
	}
	return h.wsClient.SendRevocationLeaseRenewWithNonce(sessionID, nonce)
}

// applyDesktopFenceAnswer folds a lease-renew answer into the fence.
//
// Called off the WebSocket read pump (the hook must not block and this may
// write the fence state file), but through a single serial worker so two
// answers cannot be applied out of order relative to each other.
func (h *Heartbeat) applyDesktopFenceAnswer(msg websocket.RevocationLeaseMessage) {
	switch {
	case msg.Unavailable:
		// Carries no knowledge: it certifies nothing and records nothing. It
		// only releases a waiter, which then refuses its start.
		h.desktopStartFence.noteSyncUnavailable(msg.SessionID, msg.SyncNonce)
	case msg.Revoked:
		gen, hasGen := parseWireGeneration(msg.TerminalGeneration, "terminalGeneration", msg.SessionID)
		h.desktopStartFence.noteSync(msg.SessionID, desktopFenceSyncInput{
			Generation:    gen,
			HasGeneration: hasGen,
			Terminal:      true,
			Nonce:         msg.SyncNonce,
		})
	default:
		gen, hasGen := parseWireGeneration(msg.StartGeneration, "startGeneration", msg.SessionID)
		h.desktopStartFence.noteSync(msg.SessionID, desktopFenceSyncInput{
			Generation:    gen,
			HasGeneration: hasGen,
			// Anything other than an explicit 'none' is a session in (or past)
			// teardown. An empty phase is a pre-W05 API, which is not a claim
			// either way — absence is not "terminal".
			Terminal: msg.TerminationPhase != "" && msg.TerminationPhase != "none",
			Nonce:    msg.SyncNonce,
		})
	}
}

// parseWireGeneration decodes a generation field from a lease answer. A
// malformed value is dropped with a warning rather than coerced: the answer's
// other knowledge (terminal, in particular) still applies, and a generation we
// cannot compare is one we must not pretend to have.
func parseWireGeneration(raw, field, sessionID string) (int64, bool) {
	gen, has, err := parseDesktopGenerationField(map[string]any{field: raw}, field)
	if err != nil {
		log.Warn("dropping a malformed generation from a revocation lease answer",
			"sessionId", sessionID, "field", field, "error", err.Error())
		return 0, false
	}
	return gen, has
}

// enqueueDesktopFenceAnswer hands an answer to the serial fence worker. The
// worker exists so fence writes (which touch the disk) never run on the WS
// read pump and never reorder relative to one another.
func (h *Heartbeat) enqueueDesktopFenceAnswer(msg websocket.RevocationLeaseMessage) {
	h.desktopFenceWorkerOnce.Do(func() {
		h.desktopFenceQueue = make(chan websocket.RevocationLeaseMessage, 64)
		go func() {
			for m := range h.desktopFenceQueue {
				h.applyDesktopFenceAnswer(m)
			}
		}()
	})
	select {
	case h.desktopFenceQueue <- msg:
	default:
		// The queue is only full if the worker is wedged. Applying inline is
		// worse than dropping: a dropped answer times out a resync, which
		// fails the start CLOSED — the safe direction.
		log.Warn("desktop fence answer queue full; dropping the answer",
			"sessionId", msg.SessionID)
	}
}

// desktopFenceSnapshotForHelper renders the fence for a helper seed. Only
// sessions the fence actually knows something about are included: a session
// with no high-water mark and no tombstone carries no knowledge, and shipping
// it would only grow the message.
func (h *Heartbeat) desktopFenceSnapshotForHelper() ipc.DesktopFenceSync {
	out := ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{}}
	for id, entry := range h.desktopStartFence.snapshot() {
		// The floor is the highest generation this service knows about from
		// either source: a start it admitted, or one the control plane echoed.
		floor := entry.HighWater
		hasFloor := entry.HasHighWater
		if entry.SyncedGeneration > floor || (!hasFloor && entry.SyncedGeneration > 0) {
			floor = entry.SyncedGeneration
			hasFloor = true
		}
		if !hasFloor && !entry.Terminal {
			// Nothing to tell the helper about this session.
			continue
		}
		e := ipc.DesktopFenceEntry{Terminal: entry.Terminal}
		if hasFloor {
			e.HighWater = strconv.FormatInt(floor, 10)
		}
		out.Sessions[id] = e
	}
	return out
}

// helperFenceSyncTimeout bounds the seed round trip. It is a small JSON
// message against a helper that just answered its auth handshake; a helper
// that cannot answer this cannot be trusted to run a fenced start either.
const helperFenceSyncTimeout = 10 * time.Second

// ensureHelperFenceSynced seeds a helper session with this service's fence,
// once per helper session. A failure is returned, never swallowed: the caller
// refuses the start rather than running it against an unfenced helper.
func (h *Heartbeat) ensureHelperFenceSynced(session *sessionbroker.Session) error {
	if session == nil {
		return errors.New("no helper session")
	}
	h.mu.Lock()
	if h.helperFenceSynced == nil {
		h.helperFenceSynced = make(map[string]bool)
	}
	already := h.helperFenceSynced[session.SessionID]
	h.mu.Unlock()
	if already {
		return nil
	}

	snapshot := h.desktopFenceSnapshotForHelper()
	resp, err := session.SendCommand("desk-fence-"+session.SessionID, ipc.TypeDesktopFenceSync, snapshot, helperFenceSyncTimeout)
	if err != nil {
		return err
	}
	if resp.Error != "" {
		return errors.New(resp.Error)
	}

	h.mu.Lock()
	h.helperFenceSynced[session.SessionID] = true
	h.mu.Unlock()
	log.Info("seeded the desktop start fence on a helper session",
		"helperSession", session.SessionID, "sessions", len(snapshot.Sessions))
	return nil
}

// forgetHelperFenceSync drops the seeded marker when a helper session ends, so
// its successor is seeded again rather than inheriting the claim.
func (h *Heartbeat) forgetHelperFenceSync(helperSessionID string) {
	h.mu.Lock()
	delete(h.helperFenceSynced, helperSessionID)
	h.mu.Unlock()
}

// desktopStartGenerationForHelper pulls the canonical decimal generation out
// of a start_desktop payload for forwarding over IPC. Anything that is not a
// canonical decimal string yields "" — such a start was already refused by the
// service fence, and a value we could not parse must never travel as if we had.
func desktopStartGenerationForHelper(payload map[string]any) string {
	raw, _ := payload["startGeneration"].(string)
	if raw == "" {
		return ""
	}
	if _, _, err := parseDesktopGenerationField(payload, "startGeneration"); err != nil {
		return ""
	}
	return raw
}

// desktopSessionTerminalAfterStart tears a session down when a terminal
// decision landed while its start was still in flight.
//
// The fence admits a start and the session only becomes stoppable minutes of
// wall-clock later — consent prompt, helper spawn, capture setup. A stop that
// arrives inside that window finds nothing to stop (ownership is recorded
// only after the helper answers), so without this check the capture it was
// meant to prevent comes up right after it.
func (h *Heartbeat) desktopSessionTerminalAfterStart(sessionID string) bool {
	if !h.desktopStartFence.isTerminal(sessionID) {
		return false
	}
	log.Warn("a terminal decision landed while this desktop start was in flight; tearing it down",
		"sessionId", sessionID)
	if h.sessionBroker != nil {
		if session := h.desktopOwnerSession(sessionID); session != nil {
			req := ipc.DesktopStopRequest{SessionID: sessionID}
			if _, err := session.SendCommand("desk-stop-"+sessionID, ipc.TypeDesktopStop, req, 10*time.Second); err != nil {
				// KEEP the owner mapping. It is the only thing that can route a
				// later stop (an operator retry, a revocation-lease answer
				// forwarded by forwardRevocationLeaseToHelper) back to the
				// helper that may still be capturing. Forgetting it here would
				// permanently foreclose IPC to that helper for this session id,
				// for a session the fence has already decided must not exist —
				// the same reasoning handleStopDesktop applies on its own IPC
				// failure.
				log.Warn("failed to stop a session tombstoned during its start; keeping the helper owner mapping so a later stop can retry",
					"sessionId", sessionID, "error", err.Error())
			} else {
				h.forgetDesktopOwner(sessionID)
			}
		}
	}
	h.desktopMgr.StopSession(sessionID)
	h.releaseDesktopLeases(sessionID)
	h.takeDesktopTarget(sessionID)
	return true
}

// desktopStartTombstonedError is what the refused start reports.
func desktopStartTombstonedError() error {
	return desktopStartFenceError(desktopFenceReasonTerminal, "session was ended while the start was in flight")
}
