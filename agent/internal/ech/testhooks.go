package ech

import "time"

// Test seams. These live in a non-_test file because tests in other packages
// (heartbeat) need them; nothing in production code calls them.

// SharedEnabledForTest reports whether the shared dialer would currently use
// ECH (operator flag AND server kill switch).
func SharedEnabledForTest() bool { return Shared().enabled() }

// SetSharedForTest replaces the process-wide dialer with d and returns a func
// that restores the previous one. Transports built before the swap keep the
// dialer they captured (NewTransport binds Shared().DialTLS at construction).
func SetSharedForTest(d *Dialer) (restore func()) {
	sharedMu.Lock()
	prev := shared
	shared = d
	sharedMu.Unlock()
	return func() {
		sharedMu.Lock()
		shared = prev
		sharedMu.Unlock()
	}
}

// ForceModeForTest puts host into mode m and records signatureAt as the last
// filter signature (zero leaves none). ModeCooldown lasts the normal cooldown
// duration from the dialer's clock.
func (d *Dialer) ForceModeForTest(host string, m Mode, signatureAt time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	st := d.state(host)
	st.mode = m
	st.lastSignatureAt = signatureAt
	if m == ModeCooldown {
		st.cooldownUntil = d.opts.Now().Add(cooldownDuration)
	}
}

// SharedOneShotForTest reports whether the shared dialer is in one-shot mode.
func SharedOneShotForTest() bool { return Shared().oneShot.Load() }

// NoteECHAcceptedForTest records an ECH-accepted dial to host at at, as a
// successful ECH handshake would.
func (d *Dialer) NoteECHAcceptedForTest(host string, at time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.state(host).NoteECHAcceptedAt(at)
}
