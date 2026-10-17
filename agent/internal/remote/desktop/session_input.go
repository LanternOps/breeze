package desktop

import "log/slog"

// Session-side entry points to the SafeInput worker. Each falls back to the
// raw handler (or does nothing) when the session was built around a plain
// InputHandler, as many tests do.

func (s *Session) safeInput() *SafeInput {
	si, _ := s.inputHandler.(*SafeInput)
	return si
}

// releaseHeldInput releases every key and button this session holds on the
// remote machine. Called whenever the viewer may no longer be able to send
// its own releases.
func (s *Session) releaseHeldInput(reason string) {
	if si := s.safeInput(); si != nil {
		si.ReleaseAll(reason)
	}
}

func (s *Session) closeInput() {
	if si := s.safeInput(); si != nil {
		si.Close()
	}
}

func (s *Session) injectText(text string) error {
	if si := s.safeInput(); si != nil {
		return si.InjectText(text)
	}
	return InjectText(s.inputHandler, text)
}

// onViewerDataChannelClosed: a closed input or control channel means the
// viewer can no longer deliver key-ups.
func (s *Session) onViewerDataChannelClosed(label string) {
	s.releaseHeldInput(label + "_channel_closed")
}

// onPeerDisconnected releases immediately rather than after the 20 s ICE
// grace: ending an in-progress drag is better than a latched Shift for 20 s
// on the customer's machine. The viewer is not told: if ICE recovers, a key
// the operator is still physically holding stays released on the remote
// until they press it again (the viewer's own held-key set still lists it).
func (s *Session) onPeerDisconnected() {
	s.releaseHeldInput("peer_disconnected")
}

// acceptViewerChannel admits a newly opened input or input-r channel. An
// input-r without reliable ordered delivery is refused: the ordering barrier
// assumes no discrete event on it is lost or overtaken. The caller closes it.
// A W3 viewer falls back to the legacy protocol when input-r closes.
func (s *Session) acceptViewerChannel(label string, ch any, reliable bool) bool {
	if label == "input-r" && !reliable {
		slog.Warn("Refused input-r without reliable ordered delivery", "session", s.id)
		return false
	}
	s.onViewerChannelAttached(label, ch)
	return true
}

// onViewerChannelAttached records a newly opened viewer channel. A second
// channel with a label already in use is a transport replacement (spec §2).
// Input held through the old channel is released off this goroutine, because
// pion's accept loop waits for the OnDataChannel callback before it opens the
// channel (pion/webrtc@v4.2.22 sctptransport.go:358-359).
func (s *Session) onViewerChannelAttached(label string, ch any) {
	if s.attachViewerChannel(label, ch) {
		go s.releaseHeldInput(label + "_channel_replaced")
	}
}

func (s *Session) attachViewerChannel(label string, ch any) (replaced bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewerChannels == nil {
		s.viewerChannels = map[string]any{}
	}
	prev, had := s.viewerChannels[label]
	s.viewerChannels[label] = ch
	if label == "input-r" {
		s.inputRAttached.Store(true)
	}
	return had && prev != ch
}

func (s *Session) isCurrentViewerChannel(label string, ch any) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.viewerChannels[label] == ch
}

// viewerChannelMessage routes a message from a specific channel, ignoring
// channels that have been replaced (or were never admitted).
func (s *Session) viewerChannelMessage(label string, ch any, data []byte) {
	if !s.isCurrentViewerChannel(label, ch) {
		slog.Debug("Ignored message on a superseded viewer channel", "session", s.id, "channel", label)
		return
	}
	s.onViewerDataChannelMessage(label, data)
}

// onViewerChannelClosed releases held input only if ch is still the session's
// channel for label. A superseded channel that closes late must not reset a
// stream the viewer has already re-handshaken on its replacement.
//
// If the replacement attaches between this check and the reset below, the
// reset also releases what the replacement pressed and closes its gate. That
// is a spurious reset, which is safe: the viewer is told the new epoch and
// re-handshakes. Skipping the reset instead would strand keys a legacy viewer
// pressed through the closed channel (review item R7, rejected).
func (s *Session) onViewerChannelClosed(label string, ch any) {
	s.mu.Lock()
	current := s.viewerChannels[label] == ch
	if current {
		delete(s.viewerChannels, label)
	}
	s.mu.Unlock()
	if !current {
		slog.Debug("Superseded viewer channel closed", "session", s.id, "channel", label)
		return
	}
	s.onViewerDataChannelClosed(label)
	if label == "input-r" {
		if si := s.safeInput(); si != nil {
			si.LeaveSequencedMode()
		}
	}
}

// wireInputEpochHooks tells the viewer about agent-side resets. onReset runs on
// the resetting goroutine and onResync on the input worker. Neither may wait on
// Session, so both only spawn.
func (s *Session) wireInputEpochHooks() {
	si := s.safeInput()
	if si == nil {
		return
	}
	si.SetHooks(safeInputHooks{
		onReset:  func(reason string) { go s.announceInputEpoch(reason) },
		onResync: func() { go s.announceInputEpoch("resync") },
	})
}

// inputEpochAnnouncement builds the input_epoch control message. It carries
// the reset epoch only: the geometry epoch travels with geometry, in
// monitor_switched, so a viewer never adopts it before it has the new frame.
func (s *Session) inputEpochAnnouncement(reason string) (map[string]any, bool) {
	si := s.safeInput()
	if si == nil || !s.inputRAttached.Load() {
		return nil, false
	}
	epoch, _ := si.Epochs()
	return map[string]any{"type": "input_epoch", "epoch": epoch, "reason": reason}, true
}

func (s *Session) announceInputEpoch(reason string) {
	if body, ok := s.inputEpochAnnouncement(reason); ok {
		s.sendControlJSON(body)
	}
}

// resetInputGeometry releases held input and moves the reset and geometry
// epochs. Call it with geometryMu held, before the input offset changes.
func (s *Session) resetInputGeometry(reason string) {
	if si := s.safeInput(); si != nil {
		si.ResetGeometry(reason)
		return
	}
	s.releaseHeldInput(reason)
}

func (s *Session) monitorSwitchedMessage(index, width, height int) map[string]any {
	body := map[string]any{"type": "monitor_switched", "index": index, "width": width, "height": height}
	if si := s.safeInput(); si != nil {
		epoch, geo := si.Epochs()
		body["inputEpoch"] = epoch
		body["geoEpoch"] = geo
	}
	return body
}

func (s *Session) currentDisplayIndex() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.displayIndex
}

// announceCurrentMonitor sends monitor_switched for the monitor the session is
// on now, with the current epochs. Used after a geometry transition that kept
// the monitor: a desktop switch, or a monitor switch whose capturer failed.
func (s *Session) announceCurrentMonitor() {
	s.mu.RLock()
	capturer, index := s.capturer, s.displayIndex
	s.mu.RUnlock()
	w, h := 0, 0
	if capturer != nil {
		if bw, bh, err := capturer.GetScreenBounds(); err == nil {
			w, h = bw, bh
		}
	}
	s.sendControlJSON(s.monitorSwitchedMessage(index, w, h))
}

// isReliableOrdered reports whether a data channel delivers every message in
// order, which is what the ordering barrier assumes of input-r.
func isReliableOrdered(ordered bool, maxRetransmits, maxPacketLifeTime *uint16) bool {
	return ordered && maxRetransmits == nil && maxPacketLifeTime == nil
}
