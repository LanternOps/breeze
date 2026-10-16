package ech

import "time"

// Mode is how the next TLS dial to a host should be made.
type Mode int

const (
	// ModePlain dials without ECH.
	ModePlain Mode = iota
	// ModeECH dials with the cached ECH config.
	ModeECH
	// ModeCooldown dials plain while ECH is paused after repeated failures.
	ModeCooldown
)

func (m Mode) String() string {
	switch m {
	case ModePlain:
		return "plain"
	case ModeECH:
		return "ech"
	case ModeCooldown:
		return "cooldown"
	}
	return "unknown"
}

const (
	signatureDedupeWindow = 30 * time.Second
	signatureThreshold    = 2
	signaturePeriod       = 10 * time.Minute
	echFailureLimit       = 3
	cooldownDuration      = time.Hour
)

// hostState is the per-host plain/ech/cooldown state machine. It is pure and
// clock-injected. It is not safe for concurrent use; the Dialer holds the lock.
type hostState struct {
	mode            Mode
	sigEvents       []time.Time
	echFailures     int
	cooldownUntil   time.Time
	lastSignatureAt time.Time
}

func newHostState() *hostState {
	return &hostState{mode: ModePlain}
}

// Mode returns the current mode, expiring an elapsed cooldown back to plain.
func (s *hostState) Mode(now time.Time) Mode {
	if s.mode == ModeCooldown && !now.Before(s.cooldownUntil) {
		s.mode = ModePlain
		s.sigEvents = nil
	}
	return s.mode
}

// NoteSignature records a plaintext-HTTP-on-TLS-port answer. It returns true
// only on the transition into ModeECH.
func (s *hostState) NoteSignature(now time.Time) (engaged bool) {
	s.lastSignatureAt = now
	if s.Mode(now) != ModePlain {
		return false
	}
	if n := len(s.sigEvents); n > 0 && now.Sub(s.sigEvents[n-1]) <= signatureDedupeWindow {
		return false
	}
	kept := s.sigEvents[:0]
	for _, e := range s.sigEvents {
		if now.Sub(e) <= signaturePeriod {
			kept = append(kept, e)
		}
	}
	s.sigEvents = append(kept, now)
	if len(s.sigEvents) >= signatureThreshold {
		s.mode = ModeECH
		s.echFailures = 0
		return true
	}
	return false
}

// NoteECHSuccess resets the consecutive ECH failure counter.
func (s *hostState) NoteECHSuccess() { s.echFailures = 0 }

// NoteECHFailure counts a failed ECH dial; it returns true when the failure
// limit is reached and the host enters ModeCooldown. No-op outside ModeECH.
func (s *hostState) NoteECHFailure(now time.Time) (cooled bool) {
	if s.mode != ModeECH {
		return false
	}
	s.echFailures++
	if s.echFailures < echFailureLimit {
		return false
	}
	s.mode = ModeCooldown
	s.cooldownUntil = now.Add(cooldownDuration)
	s.echFailures = 0
	return true
}

// NotePlainSuccess leaves ModeECH: a plain dial worked, so the filter is gone.
// It does nothing in ModePlain or ModeCooldown.
func (s *hostState) NotePlainSuccess() {
	if s.mode == ModeECH {
		s.mode = ModePlain
		s.sigEvents = nil
		s.echFailures = 0
	}
}

// LastSignatureAt returns the last signature seen, or the zero time.
func (s *hostState) LastSignatureAt() time.Time { return s.lastSignatureAt }
