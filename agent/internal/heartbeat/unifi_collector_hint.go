package heartbeat

// UniFi collector presence hint (#7970).
//
// The API sets configUpdate.unifi_collectors_assigned on each heartbeat: true
// when this device is the collector for at least one enabled UniFi controller,
// false when it is not. Absent (an older API, or the server could not tell this
// beat) means no change. The UniFi config loop backs off to a long idle interval
// once it sees an empty collector list; a true hint wakes it so a new
// assignment is picked up within about one heartbeat. A false hint is not acted
// on: the loop's own fetch is what moves it to idle.

// SetUnifiCollectorWake registers the callback a true hint invokes, typically
// (*unifi.Waker).Wake. It must not block: it runs on the heartbeat goroutine.
// Nil clears it.
func (h *Heartbeat) SetUnifiCollectorWake(wake func()) {
	if wake == nil {
		h.unifiCollectorWake.Store(nil)
		return
	}
	h.unifiCollectorWake.Store(&wake)
}

func (h *Heartbeat) applyUnifiCollectorHint(raw any) {
	assigned, ok := raw.(bool)
	if !ok || !assigned {
		return
	}
	if wake := h.unifiCollectorWake.Load(); wake != nil {
		(*wake)()
	}
}
