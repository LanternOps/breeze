package heartbeat

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/mtls"
)

// The protocol steps of the bounded rebind (#8318 §6.3–§6.6): phase 1,
// confirm, the probe as the target, the identity swap and the restart. Each
// step persists what the next one relies on before calling; see
// rebind_flow.go for the state and the triggers.

// advanceRebind moves the set through its phases until a step must wait.
// Bounded: contradictory answers cannot loop.
func (h *Heartbeat) advanceRebind(s *config.RebindStagedSet) {
	for range 8 {
		var next *config.RebindStagedSet
		switch s.Phase {
		case config.RebindPhaseGenerated:
			next = h.rebindStage(s)
		case config.RebindPhaseStaged:
			next = h.rebindConfirm(s)
		case config.RebindPhaseConfirmed:
			h.rebindSwap(s)
			return
		default:
			return // ended: waits for the source credentials to be proven current
		}
		if next == nil {
			return
		}
		s = next
	}
}

func (h *Heartbeat) rebindWait(now time.Time, msg string, ans rebindAnswer) {
	h.logRebindOnce("warn", msg, ans.String())
	h.rebindRetryLater(now, ans.retryAfter)
}

// rebindStage is phase 1 (§6.3, the hand-off's phase 1 table).
func (h *Heartbeat) rebindStage(s *config.RebindStagedSet) *config.RebindStagedSet {
	now := rebindNow()
	ans := h.postRebindStage(s)
	switch {
	case ans.status == http.StatusOK:
		return h.acceptRebindStage(s, ans, now)
	case ans.status == 0:
		// A lost response: phase 1 again with the same hashes is a retry.
		h.rebindWait(now, "reattach phase 1 got no answer; resending the same staged set", ans)
	case ans.refusal.intentOver(ans.status):
		h.endRebind(s, ans)
	case ans.status == http.StatusConflict && ans.refusal.State == "confirmed":
		// Confirm already committed: the token learns the identity.
		return h.rebindConfirm(s)
	case ans.status == http.StatusConflict && ans.refusal.Code == rebindCodeConfirmationTokenReused && ans.refusal.State == "":
		// Nothing was staged; the intent is still requested.
		return h.regenerateRebindSet(s, now, ans, true)
	case ans.refusal.setRefused(ans.status):
		// A malformed body or a set with duplicate hashes: nothing was staged.
		return h.regenerateRebindSet(s, now, ans, false)
	case ans.status == http.StatusNotFound && ans.refusal.Code == rebindCodeIntentNotFound:
		h.endRebind(s, ans)
	case ans.status == http.StatusUnauthorized:
		h.rebind.sourceRejected.Store(true)
		h.rebindWait(now, "reattach phase 1: the source credentials were rejected", ans)
	default:
		// 403 agent_role_required, 429, 503 certificate_unavailable, 5xx, or
		// a code this build does not know: the same hashes later.
		h.rebindWait(now, "reattach phase 1 was not accepted; resending the same staged set later", ans)
	}
	return nil
}

func (h *Heartbeat) acceptRebindStage(s *config.RebindStagedSet, ans rebindAnswer, now time.Time) *config.RebindStagedSet {
	var resp rebindStageResponse
	if err := json.Unmarshal(ans.body, &resp); err != nil {
		h.rebindWait(now, "reattach phase 1 answered 200 with an unreadable body; resending", rebindAnswer{status: ans.status})
		return nil
	}
	t := resp.Target
	switch {
	case resp.IntentID != s.IntentID || !rebindAgentIDPattern.MatchString(resp.StagedAgentID) || t == nil ||
		!identityUUIDPattern.MatchString(t.DeviceID) || !identityUUIDPattern.MatchString(t.OrgID) || !identityUUIDPattern.MatchString(t.SiteID):
		h.rebindWait(now, "reattach phase 1 answered 200 with an incomplete body; resending", rebindAnswer{status: ans.status})
		return nil
	case !s.DirectiveTarget.Equal(*t):
		// Never confirm a target other than the one the signed directive
		// named. A site the target moved to since comes with the next
		// directive (refreshRebindTarget), and phase 1 is retried then.
		h.logRebindOnce("error", "reattach phase 1 named a different target than the signed directive; not confirming",
			"intent "+s.IntentID)
		h.rebindRetryLater(now, 0)
		return nil
	}
	if resp.Certificate != nil {
		if _, err := mtls.LoadClientCert(resp.Certificate.Certificate, resp.Certificate.PrivateKey); err != nil {
			h.rebindWait(now, "reattach phase 1 returned an unusable certificate; resending for a fresh one", rebindAnswer{status: ans.status})
			return nil
		}
	}
	next := *s
	next.Phase = config.RebindPhaseStaged
	next.StagedAgentID = resp.StagedAgentID
	next.Target = &config.RebindTarget{DeviceID: t.DeviceID, OrgID: t.OrgID, SiteID: t.SiteID}
	next.StagedExpiresAt = resp.ExpiresAt
	// A lost-response retry issues a fresh certificate and revokes the
	// previous one: keep the newest. Null keeps what is on disk (no provider).
	if resp.Certificate != nil {
		c := *resp.Certificate
		next.Certificate = &c
	}
	if err := h.persistRebind(&next); err != nil {
		// Not confirming on a staged state the disk does not hold. Phase 1
		// again is a lost-response retry.
		h.logRebindOnce("error", "could not persist the staged reattach state; not confirming until it is on disk", err.Error())
		h.rebindRetryLater(now, 0)
		return nil
	}
	h.rebindProgressed()
	log.Info("reattach staged; confirming", "intentId", s.IntentID, "stagedAgentId", resp.StagedAgentID,
		"certificate", resp.Certificate != nil)
	return &next
}

// regenerateRebindSet replaces a set the server refused as a set (nothing
// was staged) with a fresh one, persisted before it is sent. sendNow: send
// it at once (confirmation_token_reused); otherwise after the backoff.
func (h *Heartbeat) regenerateRebindSet(s *config.RebindStagedSet, now time.Time, ans rebindAnswer, sendNow bool) *config.RebindStagedSet {
	if h.rebind.regenerations.Add(1) > rebindMaxRegenerations {
		h.rebindWait(now, "reattach phase 1 keeps refusing freshly generated sets; waiting", ans)
		return nil
	}
	next := *s
	next.Phase = config.RebindPhaseGenerated
	next.StagedAgentID, next.Target, next.StagedExpiresAt, next.Certificate = "", nil, "", nil
	if err := fillRebindSecrets(&next); err != nil {
		h.logRebindOnce("error", "could not generate a staged reattach set", err.Error())
		h.rebindRetryLater(now, 0)
		return nil
	}
	if err := h.persistRebind(&next); err != nil {
		h.logRebindOnce("error", "could not persist a fresh staged reattach set", err.Error())
		h.rebindRetryLater(now, 0)
		return nil
	}
	log.Warn("reattach phase 1 refused the staged set itself; generated and persisted a fresh one",
		"intentId", s.IntentID, "answer", ans.String())
	if sendNow {
		return &next
	}
	h.rebindRetryLater(now, ans.retryAfter)
	return nil
}

// endRebind records that the server ended the intent. The set stays on disk
// until the source credentials are proven current.
func (h *Heartbeat) endRebind(s *config.RebindStagedSet, ans rebindAnswer) {
	now := rebindNow()
	h.rebind.ended.Store(s.IntentID, struct{}{})
	h.rebindProgressed()
	next := *s
	next.Phase = config.RebindPhaseEnded
	next.EndedState = ans.refusal.State
	next.EndedCode = ans.refusal.Code
	endedAt := now.UTC()
	next.EndedAt = &endedAt
	if err := h.persistRebind(&next); err != nil {
		// The set keeps its phase on disk; the next call gets the same answer.
		h.logRebindOnce("warn", "could not record the ended reattach intent", err.Error())
	}
	cancelReason := ""
	if ans.refusal.CancelReason != nil {
		cancelReason = *ans.refusal.CancelReason
	}
	log.Warn("the reattach intent is over; keeping the staged set until the source credentials are proven current",
		"intentId", s.IntentID, "status", ans.status, "code", ans.refusal.Code, "state", ans.refusal.State,
		"cancelReason", cancelReason)
}

// rebindConfirm is phase 2 (§6.4, the hand-off's confirm table). A set in
// phase generated reaches it only when phase 1 said the intent is confirmed.
func (h *Heartbeat) rebindConfirm(s *config.RebindStagedSet) *config.RebindStagedSet {
	now := rebindNow()
	ans := h.postRebindConfirm(s)
	switch {
	case ans.status == http.StatusOK:
		var id config.RebindConfirmedIdentity
		if err := json.Unmarshal(ans.body, &id); err != nil || !rebindAgentIDPattern.MatchString(id.AgentID) ||
			!identityUUIDPattern.MatchString(id.DeviceID) || !identityUUIDPattern.MatchString(id.OrgID) ||
			!identityUUIDPattern.MatchString(id.SiteID) {
			// Replays answer 200 at any later time: ask again.
			h.rebindWait(now, "reattach confirm answered 200 with an unreadable identity; replaying", rebindAnswer{status: ans.status})
			return nil
		}
		if !rebindIdentitySigned(s, id) {
			h.refuseRebindIdentity(s, id)
			return nil
		}
		return h.confirmRebind(s, id, now, "confirm")
	case ans.refusal.intentOver(ans.status):
		h.endRebind(s, ans)
		return nil
	case ans.status == http.StatusConflict && ans.refusal.Code == rebindCodeNotStaged:
		// Phase 1 never completed: run it with the same hashes.
		next := *s
		next.Phase = config.RebindPhaseGenerated
		if err := h.persistRebind(&next); err != nil {
			h.logRebindOnce("warn", "could not record the reattach state", err.Error())
			h.rebindRetryLater(now, 0)
			return nil
		}
		return &next
	}
	// 401 invalid_confirmation, 403 certificate_binding_failed, 429, 5xx, no
	// answer: never discarded on that alone. With the source refused, a
	// committed confirm whose answer was lost is the likely cause: probe.
	if h.rebind.sourceRejected.Load() && s.Phase == config.RebindPhaseStaged {
		if next := h.rebindProbe(s, now); next != nil {
			return next
		}
	}
	h.rebindWait(now, "reattach confirm was not accepted; keeping the staged set and retrying", ans)
	return nil
}

// rebindProbe heartbeats as the target with the staged set. Success means a
// confirm committed; anything else (a 401 included: possibly the agent-auth
// negative cache) is retried later.
func (h *Heartbeat) rebindProbe(s *config.RebindStagedSet, now time.Time) *config.RebindStagedSet {
	ans := h.postRebindProbe(s)
	if ans.status != http.StatusOK {
		h.logRebindOnce("warn", "probe as the reattached device was not accepted; retrying", ans.String())
		return nil
	}
	// The device, org and site the server signed; the agent id phase 1 gave.
	id := config.RebindConfirmedIdentity{
		DeviceID: s.DirectiveTarget.DeviceID, OrgID: s.DirectiveTarget.OrgID, SiteID: s.DirectiveTarget.SiteID,
		AgentID: s.StagedAgentID,
	}
	return h.confirmRebind(s, id, now, "probe")
}

// rebindIdentitySigned reports whether a confirmed identity is the one the
// signed directive named (device, org, site) with the staged agent id phase 1
// gave. When phase 1's answer was never received (it said `confirmed`), the
// agent id cannot be checked: no signature ever covers it.
func rebindIdentitySigned(s *config.RebindStagedSet, id config.RebindConfirmedIdentity) bool {
	if !s.DirectiveTarget.Equal(config.RebindTarget{DeviceID: id.DeviceID, OrgID: id.OrgID, SiteID: id.SiteID}) {
		return false
	}
	return s.StagedAgentID == "" || id.AgentID == s.StagedAgentID
}

// refuseRebindIdentity is the fail-safe of a confirm whose identity is not the
// signed one: nothing unsigned is ever written to agent.yaml. The set is kept
// (ended, identity_mismatch) until the source credentials are proven current.
// If the server did commit, this install stays offline until a human acts:
// by design, since only a compromised or broken control plane answers so.
func (h *Heartbeat) refuseRebindIdentity(s *config.RebindStagedSet, id config.RebindConfirmedIdentity) {
	h.logRebindOnce("error", "SECURITY: reattach confirm named an identity the signed directive did not; refusing the swap",
		fmt.Sprintf("intent %s: device %s org %s site %s agent %s", s.IntentID, id.DeviceID, id.OrgID, id.SiteID, id.AgentID))
	h.endRebind(s, rebindAnswer{status: http.StatusOK, refusal: rebindRefusal{Code: rebindCodeIdentityMismatch}})
}

// confirmRebind persists the confirmed identity: from here the swap is owed
// and nothing ever discards the set.
func (h *Heartbeat) confirmRebind(s *config.RebindStagedSet, id config.RebindConfirmedIdentity, now time.Time, via string) *config.RebindStagedSet {
	next := *s
	next.Phase = config.RebindPhaseConfirmed
	next.Confirmed = &id
	if err := h.persistRebind(&next); err != nil {
		// Confirm replays answer 200, and the probe can run again.
		h.logRebindOnce("error", "the reattach is confirmed but could not be recorded; retrying", err.Error())
		h.rebindRetryLater(now, 0)
		return nil
	}
	h.rebindProgressed()
	log.Info("reattach confirmed", "via", via, "intentId", s.IntentID, "deviceId", id.DeviceID, "agentId", id.AgentID)
	return &next
}

// rebindSwap writes the confirmed identity (write-new-then-rename, see
// config.ApplyRebindIdentity) and restarts through the updater path, as the
// #8320 identity sync does: several components capture the ids at start.
func (h *Heartbeat) rebindSwap(s *config.RebindStagedSet) {
	id, err := s.Identity()
	if err != nil {
		h.logRebindOnce("error", "the confirmed reattach set is incomplete", err.Error())
		return
	}
	// No token rotation may land after the swap: its local promote would
	// write the retired source's tokens over the target's. Held for the life
	// of this process once the swap succeeds.
	if !h.tokenRotating.CompareAndSwap(false, true) {
		return // a rotation is running; the next tick swaps
	}
	cfgFile := rebindConfigFile()
	h.mu.Lock()
	err = rebindApplyIdentity(cfgFile, id)
	if err == nil {
		h.rebind.swapped.Store(true)
	}
	h.mu.Unlock()
	if err != nil {
		h.tokenRotating.Store(false)
		h.logRebindOnce("error", "the reattach is confirmed but the new identity could not be written; retrying", err.Error())
		h.rebindRetryLater(rebindNow(), 0)
		return
	}
	h.pendingRotationOnDisk.Store(false)
	h.pendingMTLSCertOnDisk.Store(false)
	if err := config.RemoveRebindStaged(cfgFile); err != nil {
		// The identity is committed on disk (its marker), so the next start
		// only removes the file.
		log.Warn("could not delete the applied staged reattach set; the next start removes it", "error", err.Error())
	}
	h.rebind.pendingOnDisk.Store(false)
	log.Info("this install is now the reattached device; restarting to load the new identity",
		"deviceId", id.DeviceID, "orgId", id.OrgID, "siteId", id.SiteID, "agentId", id.AgentID)
	h.restartForRebind()
}

func (h *Heartbeat) restartForRebind() {
	h.rebind.restartAt.Store(rebindNow().UnixNano())
	go h.runRebindRestart()
}

// retryRebindRestart tries the restart again when the last one did not
// happen: this process holds retired credentials and can do nothing else.
func (h *Heartbeat) retryRebindRestart() {
	last := h.rebind.restartAt.Load()
	if rebindNow().Sub(time.Unix(0, last)) < rebindRestartRetry {
		return
	}
	if h.rebind.restartAt.CompareAndSwap(last, rebindNow().UnixNano()) {
		go h.runRebindRestart()
	}
}

func (h *Heartbeat) runRebindRestart() {
	if err := rebindRestartFn(); err != nil {
		h.logRebindOnce("error", "restart after the reattach failed; retrying (the new identity applies on the next start)", err.Error())
	}
}
