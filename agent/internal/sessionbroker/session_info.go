package sessionbroker

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxSessionIdleMinutes caps reported idle at one week, mirroring the
// collectors/sessions.go device-session cap.
const maxSessionIdleMinutes = 10080

// BuildSessionInfoItems converts detector output to the list_sessions wire
// shape. It drops the services pseudo-session, sessions with no logged-in user
// (pre-allocated RDP listeners visible at the lock screen), and sessions whose
// ID doesn't parse. helperByWinSession marks sessions with a connected helper
// (keyed by the DetectedSession.Session string); nil means "unknown/none".
func BuildSessionInfoItems(detected []DetectedSession, helperByWinSession map[string]bool) []ipc.SessionInfoItem {
	items := make([]ipc.SessionInfoItem, 0, len(detected))
	for _, ds := range detected {
		if ds.Type == "services" || ds.Username == "" {
			continue
		}
		sessionNum, err := ParseWindowsSessionIDForHeartbeat(ds.Session)
		if err != nil {
			continue
		}
		item := ipc.SessionInfoItem{
			SessionID:       sessionNum,
			Username:        ds.Username,
			State:           ds.State,
			Type:            ds.Type,
			HelperConnected: helperByWinSession[ds.Session],
		}
		if ds.IdleKnown {
			m := int(ds.IdleFor / time.Minute)
			if m < 0 {
				m = 0
			}
			if m > maxSessionIdleMinutes {
				m = maxSessionIdleMinutes
			}
			item.IdleMinutes = &m
		}
		items = append(items, item)
	}
	return items
}
