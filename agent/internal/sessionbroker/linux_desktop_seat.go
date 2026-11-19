package sessionbroker

// The logind session currently in front of the local seat (#12117). The
// heartbeat routes a Linux desktop start by its type: an X11 session keeps
// the direct in-root path, a Wayland one goes to the per-session desktop
// helper. The answer is only a routing hint; the helper manager re-reads
// logind before it spawns anything, and admission reads it again.

// linuxDesktopSeat is the local console seat.
const linuxDesktopSeat = "seat0"

// parseLogindSeatActiveSession reads `loginctl show-seat seat0
// --property=ActiveSession` output. ok is false when the property is missing
// or names an id of an unexpected shape; ("", true) means the seat has no
// active session.
func parseLogindSeatActiveSession(out string) (id string, ok bool) {
	raw, has := parseKeyValueLines(out)["ActiveSession"]
	if !has {
		return "", false
	}
	if raw == "" {
		return "", true
	}
	if !validLogindSessionID(raw) {
		return "", false
	}
	return raw, true
}

// activeSeatDetectedSession turns logind's answer about the seat's active
// session into a DetectedSession. nil when logind does not know the id. An
// incomplete answer is kept, flagged PropertiesUnknown, so a caller never
// reads its zero values as facts.
func activeSeatDetectedSession(id string, st LogindSessionState) *DetectedSession {
	if !st.Exists {
		return nil
	}
	return &DetectedSession{
		UID:               st.UID,
		Session:           id,
		IsRemote:          st.Remote,
		Seat:              linuxDesktopSeat,
		State:             st.State,
		Class:             st.Class,
		LogindType:        st.Type,
		PropertiesUnknown: st.PropertiesUnknown,
	}
}
