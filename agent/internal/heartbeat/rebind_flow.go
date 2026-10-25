package heartbeat

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/updater"
)

// The bounded rebind, agent side (#8318 wave 1b, spec §6.1–§6.6).
//
//	directive (verified) → generate a fresh set → persist (generated)
//	  → phase 1, source credentials, hashes only → persist the staged agent
//	    id, the target and its pending certificate (staged)
//	  → confirm, confirm-only token, the staged certificate → persist the
//	    identity (confirmed)
//	  → swap the identity on disk (config.ApplyRebindIdentity) → RestartSelf.
//
// Crash safety (§6.6, the #2621 / #2773 discipline):
//   - every call is preceded by the write it depends on, so the set on disk
//     is always at least as far along as the server;
//   - one set per intent: a re-delivered directive, a restart and every retry
//     resume the set on disk and resend the SAME hashes;
//   - a set is never discarded on a bare rejection. The server saying the
//     intent is over (409 with state cancelled/expired) moves it to "ended",
//     and it is deleted only once a call authenticated with the SOURCE
//     credentials returns 2xx (they are proven current, so no confirm retired
//     them);
//   - when the source credentials are rejected while a set is staged, a
//     confirm may have committed with its answer lost: confirm is replayed,
//     and the staged set probes as the target (a heartbeat). Either success
//     completes the swap. A 401 there is never final (the agent-auth
//     negative cache, #8050, can answer one for up to 60 s).

const (
	// The retry pacing of phase 1, confirm, the probe and a failed local
	// write: 30 s doubling to 5 min, never shorter than a server Retry-After.
	// A staged intent lives 15 minutes, so the cap keeps several tries in it.
	rebindRetryMin = 30 * time.Second
	rebindRetryMax = 5 * time.Minute
	// An intent lives at most 60 min requested plus 15 min staged. A set
	// older than this, with the source credentials proven current, can never
	// be activated, whatever the server last said (or did not say).
	rebindStaleAfter = 24 * time.Hour
	// Fresh sets generated for one intent after the server refused the set
	// itself (400, or confirmation_token_reused) before this process stops.
	rebindMaxRegenerations = 3
	// How often a restart that did not happen is tried again.
	rebindRestartRetry = 5 * time.Minute
	// The refusal phase 1 and confirm answers carry.
	rebindCodeConfirmationTokenReused = "confirmation_token_reused"
	rebindCodeIntentNotFound          = "intent_not_found"
	rebindCodeNotStaged               = "not_staged"
	// The end code the agent records when confirm named an identity the
	// signed directive did not (never a server code).
	rebindCodeIdentityMismatch = "identity_mismatch"
)

// rebindAgentIDPattern is the server's agent id shape (it goes into a URL).
var rebindAgentIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// rebindState is the per-process state of the rebind flow.
type rebindState struct {
	// mu is held by a drive of the flow or a discard (TryLock only: a
	// trigger that finds it held is dropped; the next beat or tick retries).
	mu sync.Mutex
	// pendingOnDisk: a staged set exists (any phase).
	pendingOnDisk atomic.Bool
	// sourceRejected: the source credentials' last answer was a 401.
	sourceRejected atomic.Bool
	// swapped: the identity on disk is the reattached one; this process holds
	// retired credentials and only waits for its restart.
	swapped   atomic.Bool
	restartAt atomic.Int64
	// The retry pacing: failures in a row and the earliest next attempt.
	failures atomic.Int32
	retryAt  atomic.Pointer[time.Time]
	// Fresh sets generated for the current intent after a refusal of the set.
	regenerations atomic.Int32
	// Intents this process learned are over; their directives are ignored.
	ended sync.Map
	// The last reason logged by logRebindOnce.
	logged atomic.Pointer[string]
}

// Seams for tests. rebindWriteStaged and rebindApplyIdentity are the kill
// points of the crash-table tests: every persistence step goes through them.
var (
	rebindNow           = time.Now
	rebindRandRead      = rand.Read
	rebindRestartFn     = updater.RestartSelf
	rebindConfigFile    = config.ActiveConfigFile
	rebindReadStaged    = config.ReadRebindStaged
	rebindWriteStaged   = config.WriteRebindStaged
	rebindApplyIdentity = config.ApplyRebindIdentity
)

// securityCapabilitiesForBeat is this build's capability set for a beat. A
// Quick Support client never declares the rebind protocol: a disposable
// install must never become an existing device's identity.
func (h *Heartbeat) securityCapabilitiesForBeat() SecurityCapabilities {
	caps := compiledSecurityCapabilities()
	if h != nil && h.config != nil && h.config.SupportMode {
		caps.RebindProtocolVersion = 0
	}
	return caps
}

// logRebindOnce logs once per distinct reason, so a server that keeps
// sending something this agent will not act on does not log every beat.
func (h *Heartbeat) logRebindOnce(level, msg, reason string) {
	key := level + "|" + msg + "|" + reason
	if prev := h.rebind.logged.Load(); prev != nil && *prev == key {
		return
	}
	h.rebind.logged.Store(&key)
	switch level {
	case "error":
		log.Error(msg, "reason", reason)
	case "info":
		log.Info(msg, "reason", reason)
	default:
		log.Warn(msg, "reason", reason)
	}
}

func (h *Heartbeat) rebindDue(now time.Time) bool {
	at := h.rebind.retryAt.Load()
	return at == nil || !now.Before(*at)
}

// rebindRetryLater schedules the next attempt: the backoff step, or the
// server's Retry-After when longer.
func (h *Heartbeat) rebindRetryLater(now time.Time, retryAfter time.Duration) {
	n := h.rebind.failures.Add(1)
	delay := rebindRetryMin
	for i := int32(1); i < n && delay < rebindRetryMax; i++ {
		delay *= 2
	}
	delay = min(delay, rebindRetryMax)
	if retryAfter > delay {
		delay = retryAfter
	}
	at := now.Add(delay)
	h.rebind.retryAt.Store(&at)
}

func (h *Heartbeat) rebindProgressed() {
	h.rebind.failures.Store(0)
	h.rebind.retryAt.Store(nil)
}

// rebindInProgress reports whether a reattach holds this install's identity
// in flux. A NEW token rotation waits meanwhile: the server does not cancel
// the intent for one, but its local promote racing the swap could write the
// retired source's tokens over the target's.
func (h *Heartbeat) rebindInProgress() bool {
	return h != nil && (h.rebind.pendingOnDisk.Load() || h.rebind.swapped.Load())
}

// rebindOwnsIdentity reports whether the identity on disk is the reattached
// one. Every SaveTo(h.config) path checks it under h.mu: h.config still holds
// the source's agent id, device id and certificate, and SaveTo writes those.
func (h *Heartbeat) rebindOwnsIdentity() bool {
	return h != nil && h.rebind.swapped.Load()
}

func newRebindSecret(prefix string) (string, error) {
	var b [32]byte
	if _, err := rebindRandRead(b[:]); err != nil {
		return "", fmt.Errorf("generating a staged secret: %w", err)
	}
	return prefix + hex.EncodeToString(b[:]), nil
}

// fillRebindSecrets generates the four secrets of a staged set (§6.3): the
// agent, watchdog and helper tokens (`brz_` + 64 hex, as enrollment issues
// them) and the confirm-only token (`brz_rbc_` + 64 hex).
func fillRebindSecrets(s *config.RebindStagedSet) error {
	var err error
	if s.AuthToken, err = newRebindSecret("brz_"); err != nil {
		return err
	}
	if s.WatchdogAuthToken, err = newRebindSecret("brz_"); err != nil {
		return err
	}
	if s.HelperAuthToken, err = newRebindSecret("brz_"); err != nil {
		return err
	}
	if s.ConfirmationToken, err = newRebindSecret("brz_rbc_"); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, t := range []string{s.AuthToken, s.WatchdogAuthToken, s.HelperAuthToken, s.ConfirmationToken} {
		if seen[t] {
			return errors.New("generated staged secrets are not distinct")
		}
		seen[t] = true
	}
	return nil
}

func newRebindStagedSet(d *RebindDirective, sourceAgentID string, now time.Time) (*config.RebindStagedSet, error) {
	s := &config.RebindStagedSet{
		Version:         config.RebindStagedVersion,
		Phase:           config.RebindPhaseGenerated,
		IntentID:        d.IntentID,
		SourceAgentID:   sourceAgentID,
		DirectiveTarget: config.RebindTarget{DeviceID: d.TargetDeviceID, OrgID: d.TargetOrgID, SiteID: d.TargetSiteID},
		CreatedAt:       now.UTC(),
	}
	if err := fillRebindSecrets(s); err != nil {
		return nil, err
	}
	return s, nil
}

// handleRebindDirective verifies a directive from a heartbeat response and
// starts (or resumes) the flow for it. hold: an identity restart or a
// rollback is pending; the directive comes again on the next beat.
func (h *Heartbeat) handleRebindDirective(d *RebindDirective, hold bool) {
	if d == nil || h == nil || h.config == nil || h.config.SupportMode || hold {
		return
	}
	if err := verifyRebindDirective(d, h.config.AgentID, h.pinnedManifestPubKeys(), rebindNow()); err != nil {
		h.logRebindOnce("warn", "ignoring rebind directive", err.Error())
		return
	}
	if _, over := h.rebind.ended.Load(d.IntentID); over {
		return
	}
	go h.driveRebind(d)
}

// noteSourceCredentialsCurrent runs on every 2xx a call authenticated with
// this install's (source) credentials got: they are proven current, so no
// confirm retired them, and a set the server ended can go.
func (h *Heartbeat) noteSourceCredentialsCurrent() {
	if h == nil {
		return
	}
	h.rebind.sourceRejected.Store(false)
	if !h.rebind.pendingOnDisk.Load() || h.rebind.swapped.Load() {
		return
	}
	if !h.rebind.mu.TryLock() {
		return
	}
	defer h.rebind.mu.Unlock()
	s, err := h.loadRebindStaged()
	if err != nil || s == nil {
		return
	}
	if reason := rebindDiscardReason(s, rebindNow()); reason != "" {
		h.discardRebindStaged(s, reason)
	}
}

// noteSourceCredentialsRejected runs on a 401 to the source's heartbeat. With
// a staged set on disk, a confirm may have committed with its answer lost:
// replay it and probe as the target.
func (h *Heartbeat) noteSourceCredentialsRejected() {
	if h == nil || !h.rebind.pendingOnDisk.Load() || h.rebind.swapped.Load() {
		return
	}
	h.rebind.sourceRejected.Store(true)
	go h.driveRebind(nil)
}

// tickRebind runs on every heartbeat tick, before the auth-dead skip: an
// agent whose confirm committed while its answer was lost is exactly one
// whose source credentials are now refused.
func (h *Heartbeat) tickRebind() {
	if h == nil {
		return
	}
	if h.rebind.swapped.Load() || h.rebind.pendingOnDisk.Load() {
		go h.driveRebind(nil)
	}
}

// resumeRebind picks up a staged set a previous process left (§6.6, every
// row of the crash table). A confirmed one was normally finished at start-up
// already (config.FinishConfirmedRebind).
func (h *Heartbeat) resumeRebind() {
	h.driveRebind(nil)
}

func rebindDiscardReason(s *config.RebindStagedSet, now time.Time) string {
	switch s.Phase {
	case config.RebindPhaseEnded:
		return "the server ended the intent (" + s.EndedCode + ")"
	case config.RebindPhaseGenerated, config.RebindPhaseStaged:
		age := now.Sub(s.CreatedAt)
		if age < 0 {
			age = -age
		}
		if age > rebindStaleAfter {
			return "the staged set outlived any intent it could belong to"
		}
	}
	return ""
}

// loadRebindStaged reads the staged set and keeps pendingOnDisk in step. A
// provably corrupt file has been moved aside and counts as none (the "staged
// set lost" row of §6.6). A file that could not be read now (I/O, a scan
// holding it, an owner check that did not answer) keeps pendingOnDisk set: it
// may hold a confirmed set, so the tick and the source-401 path keep reading
// it, with backoff, until a read succeeds. Caller holds rebind.mu.
func (h *Heartbeat) loadRebindStaged() (*config.RebindStagedSet, error) {
	s, err := rebindReadStaged(rebindConfigFile())
	if errors.Is(err, config.ErrRebindStagedUnusable) {
		h.logRebindOnce("error", "moved a corrupt staged reattach set aside", err.Error())
		h.rebind.pendingOnDisk.Store(false)
		return nil, nil
	}
	if err != nil {
		h.rebind.pendingOnDisk.Store(true)
		return nil, err
	}
	h.rebind.pendingOnDisk.Store(s != nil)
	return s, nil
}

// discardRebindStaged deletes a set that can never be activated. Caller holds
// rebind.mu.
func (h *Heartbeat) discardRebindStaged(s *config.RebindStagedSet, reason string) bool {
	if err := config.RemoveRebindStaged(rebindConfigFile()); err != nil {
		h.logRebindOnce("warn", "could not delete a staged reattach set that can no longer be used; retrying", err.Error())
		return false
	}
	h.rebind.ended.Store(s.IntentID, struct{}{})
	h.rebind.pendingOnDisk.Store(false)
	h.rebindProgressed()
	log.Info("discarded the staged reattach set", "intentId", s.IntentID, "phase", s.Phase, "reason", reason)
	return true
}

// persistRebind writes the next state of the set before anything relies on
// it. Caller holds rebind.mu.
func (h *Heartbeat) persistRebind(s *config.RebindStagedSet) error {
	if err := rebindWriteStaged(rebindConfigFile(), s); err != nil {
		return err
	}
	h.rebind.pendingOnDisk.Store(true)
	return nil
}

// driveRebind runs the flow as far as it goes. d is a verified directive, or
// nil for a resume (start-up, a tick, a source 401).
func (h *Heartbeat) driveRebind(d *RebindDirective) {
	if h == nil || h.config == nil || h.config.SupportMode {
		return
	}
	if h.rebind.swapped.Load() {
		h.retryRebindRestart()
		return
	}
	if !h.rebind.mu.TryLock() {
		return
	}
	defer h.rebind.mu.Unlock()
	now := rebindNow()
	if !h.rebindDue(now) {
		return
	}
	s, err := h.loadRebindStaged()
	if err != nil {
		h.logRebindOnce("error", "cannot read the staged reattach set now; keeping it and retrying", err.Error())
		h.rebindRetryLater(now, 0)
		return
	}
	if s != nil && s.Phase == config.RebindPhaseConfirmed && s.Confirmed != nil && s.Confirmed.AgentID == h.config.AgentID {
		// This process already runs the reattached identity: the swap and its
		// restart happened, only the file's removal did not. Never re-applied
		// (that would restart again, forever); start-up removes it otherwise.
		if err := config.RemoveRebindStaged(rebindConfigFile()); err != nil {
			h.logRebindOnce("warn", "could not delete the applied staged reattach set; the next start removes it", err.Error())
		}
		h.rebind.pendingOnDisk.Store(false)
		return
	}
	if s != nil && s.Phase != config.RebindPhaseConfirmed && s.SourceAgentID != h.config.AgentID {
		// Staged under an identity this install no longer has: its
		// phase 1 and confirm name an agent id that is gone.
		if !h.discardRebindStaged(s, "staged for a previous identity of this install") {
			return
		}
		s = nil
	}
	if d != nil {
		s = h.adoptRebindDirective(s, d, now)
	}
	if s != nil {
		h.advanceRebind(s)
	}
}

// adoptRebindDirective returns the set for the directive's intent: the one on
// disk, or a fresh one generated and persisted now. Caller holds rebind.mu.
func (h *Heartbeat) adoptRebindDirective(s *config.RebindStagedSet, d *RebindDirective, now time.Time) *config.RebindStagedSet {
	if s != nil && s.IntentID == d.IntentID {
		return h.refreshRebindTarget(s, d, now)
	}
	if s != nil {
		if s.Phase == config.RebindPhaseConfirmed {
			return s // the swap is owed; never dropped
		}
		// A verified directive for ANOTHER intent came on a beat the source
		// credentials authenticated: they are current (no confirm of s retired
		// them), and s's intent is not open (one open intent per device), so
		// s can never be activated.
		if !h.discardRebindStaged(s, "superseded by a new reattach intent") {
			return nil
		}
	}
	if _, over := h.rebind.ended.Load(d.IntentID); over {
		return nil
	}
	fresh, err := newRebindStagedSet(d, h.config.AgentID, now)
	if err != nil {
		h.logRebindOnce("error", "could not generate a staged reattach set", err.Error())
		h.rebindRetryLater(now, 0)
		return nil
	}
	if err := h.persistRebind(fresh); err != nil {
		// Nothing was sent: phase 1 waits for a set on disk.
		h.logRebindOnce("error", "could not persist the staged reattach set; not staging until it is on disk", err.Error())
		h.rebindRetryLater(now, 0)
		return nil
	}
	h.rebind.regenerations.Store(0)
	log.Info("a reattach of this install was requested; staged a fresh credential set",
		"intentId", d.IntentID, "targetDeviceId", d.TargetDeviceID, "targetOrgId", d.TargetOrgID)
	return fresh
}

// refreshRebindTarget follows the site a later verified directive for the
// same intent names: the target may move site after the request, and the
// server signs its current site on every beat. The device and org never
// change for an intent; a directive naming others is ignored. Only before
// confirm. Caller holds rebind.mu.
func (h *Heartbeat) refreshRebindTarget(s *config.RebindStagedSet, d *RebindDirective, now time.Time) *config.RebindStagedSet {
	signed := config.RebindTarget{DeviceID: d.TargetDeviceID, OrgID: d.TargetOrgID, SiteID: d.TargetSiteID}
	if s.DirectiveTarget.Equal(signed) || (s.Phase != config.RebindPhaseGenerated && s.Phase != config.RebindPhaseStaged) {
		return s
	}
	if signed.DeviceID != s.DirectiveTarget.DeviceID || signed.OrgID != s.DirectiveTarget.OrgID {
		h.logRebindOnce("error", "a rebind directive for the same intent names another target; keeping the first",
			"intent "+s.IntentID)
		return s
	}
	next := *s
	next.DirectiveTarget.SiteID = signed.SiteID
	if err := h.persistRebind(&next); err != nil {
		h.logRebindOnce("warn", "could not record the reattach target's new site", err.Error())
		h.rebindRetryLater(now, 0)
		return s
	}
	return &next
}
