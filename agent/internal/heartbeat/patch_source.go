package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/winupdate"
)

// applyWinUpdate is the seam to the (Windows-only) enforcement. A package var so
// tests can capture the resolved enforce bool on any platform — the dispatch +
// payload-parse path is where a key-name regression would silently disable the
// whole feature, so it must be unit-tested even though the registry I/O cannot
// run on the CI agent.
var applyWinUpdate = winupdate.Apply

// applyPatchSourceConfig handles the patch_source_settings block from the
// heartbeat config update (#1872). When exclusiveWindowsUpdate is true the
// Windows agent suppresses the native Windows Update automatic-install channel;
// false reverts any enforcement Breeze previously applied. No-op on non-Windows.
func (h *Heartbeat) applyPatchSourceConfig(raw any) {
	m, ok := raw.(map[string]any)
	if !ok {
		log.Warn("ignoring invalid patch_source_settings payload: not an object")
		return
	}

	// The API may send either snake_case or camelCase.
	v, present := m["exclusiveWindowsUpdate"]
	if !present {
		v, present = m["exclusive_windows_update"]
	}
	if !present {
		log.Warn("patch_source_settings received without exclusiveWindowsUpdate field")
		return
	}
	enforce, ok := v.(bool)
	if !ok {
		log.Warn("ignoring patch_source_settings: exclusiveWindowsUpdate is not a boolean")
		return
	}

	res, err := applyWinUpdate(enforce)
	if err != nil {
		log.Error("failed to apply Windows Update source enforcement",
			"enforce", enforce, "error", err.Error())
		return
	}
	if !res.Supported {
		log.Debug("Windows Update source enforcement not supported on this platform",
			"enforce", enforce)
		return
	}
	log.Info("applied Windows Update source enforcement",
		"enforce", enforce,
		"managed", res.Managed,
		"enforced", res.Enforced,
		"reverted", res.Reverted,
		"reason", res.Reason)
}
