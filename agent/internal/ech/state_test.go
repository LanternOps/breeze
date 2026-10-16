package ech

import (
	"testing"
	"time"
)

var stateT0 = time.Date(2026, 10, 16, 0, 0, 0, 0, time.UTC)

func engagedState(t *testing.T) *hostState {
	t.Helper()
	s := newHostState()
	s.NoteSignature(stateT0)
	if !s.NoteSignature(stateT0.Add(2 * time.Minute)) {
		t.Fatal("expected engage")
	}
	return s
}

func TestState_SingleSignatureDoesNotEngage(t *testing.T) {
	s := newHostState()
	if s.NoteSignature(stateT0) {
		t.Fatal("engaged on a single signature")
	}
	if got := s.Mode(stateT0); got != ModePlain {
		t.Fatalf("mode = %v, want plain", got)
	}
}

func TestState_SignaturesWithinDedupeWindowCountOnce(t *testing.T) {
	s := newHostState()
	for _, d := range []time.Duration{0, 5 * time.Second, 20 * time.Second} {
		if s.NoteSignature(stateT0.Add(d)) {
			t.Fatalf("engaged at +%v", d)
		}
	}
	if got := s.Mode(stateT0.Add(20 * time.Second)); got != ModePlain {
		t.Fatalf("mode = %v, want plain", got)
	}
	if got := s.LastSignatureAt(); !got.Equal(stateT0.Add(20 * time.Second)) {
		t.Fatalf("lastSignatureAt = %v", got)
	}
}

func TestState_TwoEventsWithinPeriodEngage(t *testing.T) {
	s := newHostState()
	if s.NoteSignature(stateT0) {
		t.Fatal("first engaged")
	}
	if !s.NoteSignature(stateT0.Add(2 * time.Minute)) {
		t.Fatal("second did not engage")
	}
	if got := s.Mode(stateT0.Add(2 * time.Minute)); got != ModeECH {
		t.Fatalf("mode = %v, want ech", got)
	}
	if s.NoteSignature(stateT0.Add(3 * time.Minute)) {
		t.Fatal("engaged=true again while already in ECH")
	}
}

func TestState_TwoEventsOutsidePeriodDoNotEngage(t *testing.T) {
	s := newHostState()
	s.NoteSignature(stateT0)
	if s.NoteSignature(stateT0.Add(11 * time.Minute)) {
		t.Fatal("engaged across period")
	}
	if got := s.Mode(stateT0.Add(11 * time.Minute)); got != ModePlain {
		t.Fatalf("mode = %v, want plain", got)
	}
}

func TestState_ThreeECHFailuresCooldown(t *testing.T) {
	s := engagedState(t)
	now := stateT0.Add(3 * time.Minute)
	if first, second := s.NoteECHFailure(now), s.NoteECHFailure(now); first || second {
		t.Fatal("cooled early")
	}
	if !s.NoteECHFailure(now) {
		t.Fatal("third failure did not cool")
	}
	if got := s.Mode(now.Add(cooldownDuration - time.Second)); got != ModeCooldown {
		t.Fatalf("mode = %v, want cooldown", got)
	}
	if got := s.Mode(now.Add(cooldownDuration)); got != ModePlain {
		t.Fatalf("mode = %v, want plain after cooldown", got)
	}
	// sigEvents were cleared: one new signature must not engage.
	if s.NoteSignature(now.Add(cooldownDuration + time.Minute)) {
		t.Fatal("re-engaged on single signature after cooldown")
	}
}

func TestState_ECHSuccessResetsFailures(t *testing.T) {
	s := engagedState(t)
	now := stateT0.Add(3 * time.Minute)
	s.NoteECHFailure(now)
	s.NoteECHFailure(now)
	s.NoteECHSuccess()
	if first, second := s.NoteECHFailure(now), s.NoteECHFailure(now); first || second {
		t.Fatal("cooled despite reset")
	}
	if got := s.Mode(now); got != ModeECH {
		t.Fatalf("mode = %v, want ech", got)
	}
}

func TestState_PlainSuccessLeavesECH(t *testing.T) {
	s := engagedState(t)
	s.NotePlainSuccess()
	now := stateT0.Add(3 * time.Minute)
	if got := s.Mode(now); got != ModePlain {
		t.Fatalf("mode = %v, want plain", got)
	}
	if s.NoteSignature(now.Add(time.Minute)) {
		t.Fatal("re-engaged on a single signature")
	}
}

func TestState_NonECHBehaviors(t *testing.T) {
	s := newHostState()
	if s.NoteECHFailure(stateT0) {
		t.Fatal("failure in plain mode must be a no-op")
	}
	if !s.LastSignatureAt().IsZero() {
		t.Fatal("lastSignatureAt should start zero")
	}
	if ModePlain.String() != "plain" || ModeECH.String() != "ech" || ModeCooldown.String() != "cooldown" {
		t.Fatal("Mode.String mismatch")
	}
	// cooldown: plain success does nothing, signatures update lastSignatureAt only
	e := engagedState(t)
	now := stateT0.Add(3 * time.Minute)
	e.NoteECHFailure(now)
	e.NoteECHFailure(now)
	e.NoteECHFailure(now)
	e.NotePlainSuccess()
	late := now.Add(time.Minute)
	if e.NoteSignature(late) {
		t.Fatal("engaged during cooldown")
	}
	if e.Mode(late) != ModeCooldown || !e.LastSignatureAt().Equal(late) {
		t.Fatal("cooldown state wrong")
	}
}

func TestState_PlainSuccessAtRecordsTimeInEveryMode(t *testing.T) {
	plain := newHostState()
	at := stateT0.Add(time.Second)
	plain.NotePlainSuccessAt(at)
	if !plain.LastPlainSuccessAt().Equal(at) || plain.Mode(at) != ModePlain {
		t.Fatalf("plain: last=%v mode=%v", plain.LastPlainSuccessAt(), plain.Mode(at))
	}

	e := engagedState(t)
	at = stateT0.Add(3 * time.Minute)
	e.NotePlainSuccessAt(at)
	if !e.LastPlainSuccessAt().Equal(at) || e.Mode(at) != ModePlain {
		t.Fatalf("ech: last=%v mode=%v, want %v plain", e.LastPlainSuccessAt(), e.Mode(at), at)
	}

	c := engagedState(t)
	c.NoteECHFailure(at)
	c.NoteECHFailure(at)
	c.NoteECHFailure(at)
	later := at.Add(time.Minute)
	c.NotePlainSuccessAt(later)
	if !c.LastPlainSuccessAt().Equal(later) || c.Mode(later) != ModeCooldown {
		t.Fatalf("cooldown: last=%v mode=%v, want %v cooldown", c.LastPlainSuccessAt(), c.Mode(later), later)
	}
}

func TestState_ECHOnWireFollowsLastSuccess(t *testing.T) {
	s := newHostState()
	if s.ECHOnWire() {
		t.Fatal("fresh state: ECHOnWire = true")
	}
	s.mode = ModeECH
	if s.ECHOnWire() {
		t.Fatal("ech mode, no success: ECHOnWire = true")
	}
	at := time.Date(2026, 10, 16, 12, 0, 0, 0, time.UTC)
	s.NoteECHAcceptedAt(at)
	if !s.ECHOnWire() || !s.LastECHAcceptedAt().Equal(at) {
		t.Fatalf("after ECH accepted: ECHOnWire=%v LastECHAcceptedAt=%v", s.ECHOnWire(), s.LastECHAcceptedAt())
	}
	s.NotePlainSuccessAt(at)
	if s.ECHOnWire() {
		t.Fatal("after plain success at the same instant: ECHOnWire = true")
	}
	s.NoteECHAcceptedAt(at)
	if !s.ECHOnWire() {
		t.Fatal("after ECH accepted at the same instant: ECHOnWire = false")
	}
}
