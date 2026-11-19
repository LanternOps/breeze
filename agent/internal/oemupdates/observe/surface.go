package observe

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/patching"
)

// Surface observe (O4a). The Windows Update driver search only: nothing is
// downloaded or installed. Each pending update carries the shipped Surface
// filter's verdict, computed by patching.SelectSurfaceDriverUpdates, which is
// pure. driverProvider stays null: the search does not read that property, and
// reading it would change the shared COM loop the Surface lane installs through.

const (
	stepWindowsUpdate = "windows_update"
	stepWUPolicy      = "wu_policy"
)

func (c *collector) surface() {
	s, h, r := c.r.Surface, c.host, c.r

	s.ExcludeWUDriversInQU = PolicyValue{State: "unreadable"}
	if h.ExcludeWUDriversPolicy == nil {
		r.addError(stepWUPolicy, codeUnavailable)
	} else if v, present, err := h.ExcludeWUDriversPolicy(); err != nil {
		r.addError(stepWUPolicy, codeUnreadable)
	} else if !present {
		s.ExcludeWUDriversInQU = PolicyValue{State: "absent"}
	} else {
		n := int64(min(v, 1<<53-1))
		s.ExcludeWUDriversInQU = PolicyValue{State: "present", Value: &n}
	}

	if h.WindowsUpdateDisabled != nil {
		disabled, err := h.WindowsUpdateDisabled()
		if err != nil {
			// Not "disabled": the search then fails and says why, as in the lane.
			r.addError(stepWindowsUpdate, "service_state_unreadable")
		} else if disabled {
			s.WindowsUpdate = "service_disabled"
			return
		}
	}
	if h.SearchDriverUpdates == nil {
		s.WindowsUpdate = "failed"
		r.addError(stepWindowsUpdate, codeUnavailable)
		return
	}
	found, err := h.SearchDriverUpdates(c.ctx)
	if err != nil {
		s.WindowsUpdate = "failed"
		r.addError(stepWindowsUpdate, "wu_search_failed")
		return
	}
	s.WindowsUpdate = "ok"

	plan := patching.SelectSurfaceDriverUpdates(found, nil)
	verdict := make(map[string]string, len(plan.Drivers)+len(plan.Firmware))
	for _, u := range plan.Drivers {
		verdict[normalizeID(u.UpdateID)] = SelectDriver
	}
	for _, u := range plan.Firmware {
		verdict[normalizeID(u.UpdateID)] = SelectFirmware
	}
	for _, u := range found {
		sel := verdict[normalizeID(u.UpdateID)]
		if sel == "" {
			sel = SelectNone
		}
		s.Updates = append(s.Updates, SurfaceUpdate{
			Title:              cleanText(u.Title, maxUpdateTitle),
			UpdateID:           cleanText(strings.Trim(strings.TrimSpace(u.UpdateID), "{}"), maxUpdateID),
			DriverManufacturer: optText(u.DriverManufacturer, maxDriverMaker),
			DriverClass:        optText(u.DriverClass, maxDriverClass),
			DriverModel:        optText(u.DriverModel, maxDriverModel),
			LaneWouldSelect:    sel,
		})
	}
}
