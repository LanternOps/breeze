package updater

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

func newTestBackoff() (*TargetBackoff, *fakeClock) {
	clk := &fakeClock{t: time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)}
	return &TargetBackoff{Now: clk.now}, clk
}

// The #7516 storm: one deterministic failure per heartbeat, forever. After a
// failure the same target must not be retried until its backoff elapses, and
// each further failure must double the wait up to the cap.
func TestTargetBackoffExponentialPerTarget(t *testing.T) {
	b, clk := newTestBackoff()

	if _, active := b.Remaining("agent", "0.118.1"); active {
		t.Fatal("a target that never failed must not be backed off")
	}

	want := []time.Duration{
		TargetBackoffBase,
		2 * TargetBackoffBase,
		4 * TargetBackoffBase,
		8 * TargetBackoffBase,
		16 * TargetBackoffBase,
		TargetBackoffMax,
		TargetBackoffMax,
	}
	for i, w := range want {
		n, delay := b.NoteFailure("agent", "0.118.1")
		if n != i+1 {
			t.Fatalf("failure %d: count = %d", i+1, n)
		}
		if delay != w {
			t.Fatalf("failure %d: delay = %s, want %s", i+1, delay, w)
		}
		if rem, active := b.Remaining("agent", "0.118.1"); !active || rem != w {
			t.Fatalf("failure %d: Remaining = %s,%v; want %s,true", i+1, rem, active, w)
		}
		clk.advance(w - time.Second)
		if _, active := b.Remaining("agent", "0.118.1"); !active {
			t.Fatalf("failure %d: backoff lifted early", i+1)
		}
		clk.advance(time.Second)
		if _, active := b.Remaining("agent", "0.118.1"); active {
			t.Fatalf("failure %d: backoff did not lift at %s", i+1, w)
		}
	}
}

// "The agent must still upgrade promptly once a satisfiable offer appears":
// a NEW target (the operator promoted the build the server holds) is never
// held back by the old target's streak, and starts its own from zero.
func TestTargetBackoffNewTargetIsAttemptedImmediately(t *testing.T) {
	b, _ := newTestBackoff()
	for i := 0; i < 5; i++ {
		b.NoteFailure("agent", "0.118.1")
	}
	if _, active := b.Remaining("agent", "0.118.2"); active {
		t.Fatal("a different target version must not inherit the old target's backoff")
	}
	if n, delay := b.NoteFailure("agent", "0.118.2"); n != 1 || delay != TargetBackoffBase {
		t.Fatalf("new target streak = %d/%s, want 1/%s", n, delay, TargetBackoffBase)
	}
	if _, active := b.Remaining("agent", "0.118.1"); active {
		t.Fatal("one entry per component: the superseded target is forgotten")
	}
}

func TestTargetBackoffComponentsAreIndependent(t *testing.T) {
	b, _ := newTestBackoff()
	b.NoteFailure("backup", "0.118.1")
	if _, active := b.Remaining("agent", "0.118.1"); active {
		t.Fatal("a backup failure must not back off the agent component")
	}
	if _, active := b.Remaining("backup", "0.118.1"); !active {
		t.Fatal("backup failure not recorded")
	}
}

func TestTargetBackoffClearResetsTheStreak(t *testing.T) {
	b, _ := newTestBackoff()
	b.NoteFailure("user-helper", "0.118.1")
	b.NoteFailure("user-helper", "0.118.1")
	b.Clear("user-helper")
	if _, active := b.Remaining("user-helper", "0.118.1"); active {
		t.Fatal("Clear must lift the backoff")
	}
	if n, _ := b.NoteFailure("user-helper", "0.118.1"); n != 1 {
		t.Fatalf("Clear must reset the streak; count = %d", n)
	}
}

func TestTargetBackoffZeroValueUsesWallClock(t *testing.T) {
	var b TargetBackoff
	b.NoteFailure("agent", "1.0.0")
	if rem, active := b.Remaining("agent", "1.0.0"); !active || rem <= 0 || rem > TargetBackoffBase {
		t.Fatalf("zero-value TargetBackoff: Remaining = %s,%v", rem, active)
	}
}

func TestIsDeterministicArtifactFailure(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"checksum mismatch as UpdateTo wraps it", fmt.Errorf("checksum verification failed: %w",
			fmt.Errorf("%w: expected aa, got bb", ErrChecksumMismatch)), true},
		{"size mismatch (tagged checksum)", trustErrorf(ErrChecksumMismatch, "downloaded binary size mismatch"), true},
		{"manifest signature", fmt.Errorf("verify: %w", ErrManifestSignature), true},
		{"manifest key", asTrustError(ErrManifestKey, errors.New("unknown key id")), true},
		{"server 503 is transient", httpStatusErrorf(503, "download failed: 503"), false},
		{"untrusted release has its own cooldown", fmt.Errorf("%w: reason", ErrUntrustedRelease), false},
		{"file locked is transient", ErrFileLocked, false},
		{"nil", nil, false},
	}
	for _, tc := range cases {
		if got := IsDeterministicArtifactFailure(tc.err); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}
