package desktop

// Copy chords: after the agent injects one, the clipboard watcher reads the
// host clipboard at once instead of at its next poll, so a quick paste on the
// viewer cannot push the operator's older clipboard over the fresh copy
// (#11310 row 4).

// isCopyChord reports whether ev, injected now, is Ctrl/Cmd+C, Ctrl/Cmd+X or
// Ctrl+Insert, counting modifiers already held via key_down. It mirrors the
// viewer's isCopyChord (apps/viewer/src/lib/inputSafety.ts). Call it before
// prepare, which drops held modifiers from a key_press. Worker goroutine only.
//
// A false positive costs a few cheap clipboard reads; a false negative leaves
// the change to the regular poll, as before.
func (h *heldInput) isCopyChord(ev InputEvent) bool {
	if ev.Type != "key_press" && ev.Type != "key_down" {
		return false
	}
	mods := map[string]bool{}
	for _, m := range ev.Modifiers {
		mods[heldKeyName(m)] = true
	}
	for _, m := range []string{"ctrl", "meta", "alt", "shift"} {
		if h.nameHeld(m) {
			mods[m] = true
		}
	}
	if mods["alt"] {
		return false // AltGr arrives as Ctrl+Alt
	}
	key := heldKeyName(ev.Key)
	switch {
	case key == "c" || key == "x" || ev.Code == "KeyC" || ev.Code == "KeyX":
		return mods["ctrl"] || mods["meta"]
	case key == "insert" || ev.Code == "Insert":
		return mods["ctrl"] && !mods["shift"] && !mods["meta"]
	}
	return false
}

// copyChordNotifier is the clipboard watcher's side of a copy chord
// (*clipboard.ClipboardSync).
type copyChordNotifier interface {
	CopyChordInjected()
}

// onCopyChordInjected passes an injected copy chord to the clipboard watcher.
// It runs on the input worker, so it only spawns: the worker must never wait
// on Session.mu.
func (s *Session) onCopyChordInjected() {
	go func() {
		s.mu.RLock()
		n := s.clipboardNotifier
		s.mu.RUnlock()
		if n != nil {
			n.CopyChordInjected()
		}
	}()
}
