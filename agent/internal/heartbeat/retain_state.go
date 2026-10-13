package heartbeat

import (
	"bytes"
	"encoding/json"

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

// UnmarshalJSON never returns an error: this field rides on the heartbeat
// response, and a decode failure would drop the beat's commands and upgrade
// instructions. Anything that is not an array of strings degrades to "retain
// nothing" (legacy semantics); unknown names, oversized names and entries
// beyond retainStateMaxEntries are ignored.
func (r *RetainState) UnmarshalJSON(data []byte) error {
	*r = RetainState{}
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil // not an array: retain nothing
	}
	// Stream tokens and stop after retainStateMaxEntries, so parse work is
	// bounded by the cap rather than by the array length. A nested value
	// (object/array) ends parsing: it is not a list of names.
	for i := 0; i < retainStateMaxEntries && dec.More(); i++ {
		tok, err := dec.Token()
		if err != nil {
			return nil
		}
		if _, nested := tok.(json.Delim); nested {
			return nil
		}
		name, ok := tok.(string)
		if !ok || len(name) > retainStateMaxNameLen {
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
// off state — it is idempotent, retries unfinished cleanup, and can never
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

// noteRetainStreak is replaced in the next commit (retain-streak warning).
func (h *Heartbeat) noteRetainStreak(RetainState) {}
