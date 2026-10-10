package desktop

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
