package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/onedrivehelper"
)

// applyOneDrive is the seam to the (Windows-only) OneDrive helper. A package
// var so tests can capture the parsed config on any platform (same pattern as
// applyWinUpdate in patch_source.go).
var applyOneDrive = onedrivehelper.Apply

// applyOneDriveHelperConfig parses and applies onedrive_helper_settings from
// the heartbeat configUpdate, capturing the resulting device state for the
// next outgoing heartbeat. Additive/idempotent: safe to run every heartbeat.
func (h *Heartbeat) applyOneDriveHelperConfig(raw any) {
	cfg, ok := onedrivehelper.ParseConfig(raw)
	if !ok {
		log.Warn("ignoring invalid onedrive_helper_settings payload: not an object")
		return
	}
	state, err := applyOneDrive(cfg)
	if err != nil {
		log.Warn("onedrive helper apply", "error", err.Error())
	}
	if state != nil {
		h.onedriveMu.Lock()
		h.onedriveState = state
		h.onedriveMu.Unlock()
	}
}
