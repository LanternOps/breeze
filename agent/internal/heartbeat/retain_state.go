package heartbeat

import (
	"bytes"
	"encoding/json"
	"sync/atomic"

	"github.com/breeze-rmm/agent/internal/helper"
)

// retainStateProtocolVersion is declared in securityCapabilities. Version 1:
// this build honours HeartbeatResponse.RetainState (#8258).
const retainStateProtocolVersion = 1

const (
	retainStateMaxEntries = 16
	retainStateMaxNameLen = 32
)

// RetainState names the features the server made NO decision about this beat.
// For each, the agent keeps its current state instead of treating the
// missing legacy key as "off" (#8258). The zero value means "no feature
// retained", which is exactly the pre-protocol behaviour, and is what every
// response from an API that predates the protocol decodes to.
type RetainState struct {
	PAM              bool
	Helper           bool
	RemoteManagement bool
}

// retainStateMalformedWarned latches the malformed-retainState warning so it
// is logged once per process: a server that sends a bad shape sends it on
// every beat, and a per-beat line would flood every agent's log.
var retainStateMalformedWarned atomic.Bool

// logRetainStateMalformed is the log seam for that warning, so tests can count
// the lines an agent would actually emit.
var logRetainStateMalformed = func(reason string) {
	log.Warn("ignoring malformed retainState in heartbeat response; applying legacy semantics (absent = off)",
		"reason", reason)
}

func noteRetainStateMalformed(reason string) {
	if retainStateMalformedWarned.CompareAndSwap(false, true) {
		logRetainStateMalformed(reason)
	}
}

// UnmarshalJSON never returns an error: this field rides on the heartbeat
// response, and a decode failure would drop the beat's commands and upgrade
// instructions. A value that is not an array (null included) retains
// nothing, which is the legacy semantics. Within an array, entries are read
// in order: names seen before a nested object/array are kept and parsing
// stops there; non-string entries, unknown names, oversized names and
// entries beyond retainStateMaxEntries are ignored. Wrong shapes (not null,
// not unknown names, which are forward compatibility) are logged once per
// process.
func (r *RetainState) UnmarshalJSON(data []byte) error {
	*r = RetainState{}
	dec := json.NewDecoder(bytes.NewReader(data))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('[') {
		if err != nil || tok != nil { // tok == nil is JSON null: not malformed
			noteRetainStateMalformed("not an array")
		}
		return nil // retain nothing
	}
	// Stream tokens and stop after retainStateMaxEntries, so parse work is
	// bounded by the cap rather than by the array length. A nested value
	// (object/array) ends parsing: it is not a list of names.
	for i := 0; i < retainStateMaxEntries && dec.More(); i++ {
		tok, err := dec.Token()
		if err != nil {
			noteRetainStateMalformed("unreadable entry")
			return nil
		}
		if _, nested := tok.(json.Delim); nested {
			noteRetainStateMalformed("nested value")
			return nil
		}
		name, ok := tok.(string)
		if !ok {
			noteRetainStateMalformed("non-string entry")
			continue
		}
		if len(name) > retainStateMaxNameLen {
			continue
		}
		switch name {
		case "pam":
			r.PAM = true
		case "helper":
			r.Helper = true
		case "remoteManagement":
			r.RemoteManagement = true
		}
	}
	return nil
}

// applySettingsDecisions applies the PAM, remote-management and helper
// decisions of one response, in production order. It exists so the retain
// semantics are testable without the whole response pipeline;
// processHeartbeatResponse calls the two halves at their own positions (PAM
// must run before command admission).
func (h *Heartbeat) applySettingsDecisions(resp *HeartbeatResponse) {
	h.applyPAMDecision(resp)
	h.applyHelperAndRemoteManagement(resp)
}

// applyPAMDecision applies the PAM (UAC interception) decision. When the
// server retained PAM, the legacy uacInterceptionEnabled key is ignored and
// the current state is kept: if PAM is enabled nothing runs; if PAM is off
// (the boot default, or a disable whose verified cleanup may still be
// pending) the disable path keeps running exactly as it does today for an
// off state — it runs on every such beat, is idempotent (so a cleanup that
// failed to verify is retried), and can never
// enable anything. It also advances the per-beat retain-streak counters, so
// it must be called exactly once per response.
func (h *Heartbeat) applyPAMDecision(resp *HeartbeatResponse) {
	h.noteRetainStreak(resp.RetainState)
	if !resp.RetainState.PAM {
		h.handleUACInterception(resp.UacInterceptionEnabled)
		return
	}
	if !h.uacInterceptionEnabled.Load() {
		off := false
		h.handleUACInterception(&off)
	}
}

// applyHelperAndRemoteManagement applies the remote-management policy flag
// and the helper flag + settings, skipping each feature the server retained
// (its legacy keys are ignored; current state is kept).
func (h *Heartbeat) applyHelperAndRemoteManagement(resp *HeartbeatResponse) {
	if !resp.RetainState.RemoteManagement {
		h.tunnelMgr.SetManagedByPolicy(resp.ManageRemoteManagement)
	}
	if resp.RetainState.Helper {
		return
	}
	h.handleHelperEnabled(resp.HelperEnabled)
	if resp.HelperSettings != nil {
		h.helperMgr.Apply(&helper.Settings{
			Enabled:            resp.HelperSettings.Enabled,
			ShowOpenPortal:     resp.HelperSettings.ShowOpenPortal,
			ShowDeviceInfo:     resp.HelperSettings.ShowDeviceInfo,
			ShowRequestSupport: resp.HelperSettings.ShowRequestSupport,
			PortalUrl:          resp.HelperSettings.PortalUrl,
		})
		// LifecycleMode is a sessionbroker concern, not an Assist setting, so it
		// bypasses helperMgr and drives the lifecycle manager directly. Idempotent
		// and cheap — the manager no-ops when the resolved mode is unchanged.
		h.mu.Lock()
		lc := h.helperLifecycle
		h.mu.Unlock()
		if lc != nil {
			lc.SetModeOverride(resp.HelperSettings.LifecycleMode)
		}
	}
}

// retainStreakWarnBeats is the number of consecutive beats a feature may be
// retained before the agent logs a warning (about 30 minutes at the default
// interval). Log only: the state is never reverted (#8258 OD10), because
// reverting would reintroduce the enforcement downgrade retain exists to stop.
const retainStreakWarnBeats = 30

// logRetainStreakWarning is the log seam for the retain-streak warning, so
// tests can count the lines an agent would actually emit.
var logRetainStreakWarning = func(feature string, beats int64) {
	log.Warn("server has made no decision for this feature on consecutive heartbeats; keeping the last applied state",
		"feature", feature, "consecutiveBeats", beats)
}

// retainStreakTracker counts, per feature, consecutive beats on which the
// server retained it. A beat that decides the feature resets its counter.
type retainStreakTracker struct {
	pam, helper, remoteManagement atomic.Int64
}

func noteRetainStreakFeature(counter *atomic.Int64, retained bool, feature string) {
	if !retained {
		counter.Store(0)
		return
	}
	// Exactly once per streak: only the beat that reaches the threshold logs.
	if n := counter.Add(1); n == retainStreakWarnBeats {
		logRetainStreakWarning(feature, n)
	}
}

// noteRetainStreak advances the per-feature counters for one beat. Called
// exactly once per response, from applyPAMDecision.
func (h *Heartbeat) noteRetainStreak(r RetainState) {
	noteRetainStreakFeature(&h.retainStreaks.pam, r.PAM, "pam")
	noteRetainStreakFeature(&h.retainStreaks.helper, r.Helper, "helper")
	noteRetainStreakFeature(&h.retainStreaks.remoteManagement, r.RemoteManagement, "remoteManagement")
}
