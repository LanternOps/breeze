package heartbeat

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/updater"
)

// Issue #3458: the updater refuses to install a macOS binary that fails
// `codesign --verify` rather than ad-hoc re-signing it (which would give the
// agent a fresh code identity and drop its TCC grants). The refusal is terminal
// for that target version — the bytes are already checksum-verified against the
// signed manifest, so re-downloading reproduces the same failure — but not
// permanent: republishing a correctly signed build must recover the fleet on
// its own. doUpgrade therefore backs off per target version. These tests pin
// that policy on the decision helpers doUpgrade delegates to.

func TestCodeSignatureBackoff_InactiveBeforeAnyRejection(t *testing.T) {
	h := &Heartbeat{}
	if h.codeSignatureBackoffActive("0.109.0") {
		t.Fatal("a target that never failed verification must not be backed off")
	}
}

func TestCodeSignatureBackoff_ActiveAfterRejection(t *testing.T) {
	h := &Heartbeat{}
	h.noteCodeSignatureFailure("0.109.0")
	if !h.codeSignatureBackoffActive("0.109.0") {
		t.Fatal("a just-rejected target must be backed off, not retried next heartbeat")
	}
}

// Without the cooldown every macOS device re-downloads the same doomed binary
// every ~60s, which is the storm #3544 fixed for untrusted releases.
func TestCodeSignatureBackoff_SuppressesRepeatedHeartbeats(t *testing.T) {
	h := &Heartbeat{}
	attempts := 0
	for i := 0; i < 60; i++ { // an hour of heartbeats at ~60s
		if h.codeSignatureBackoffActive("0.109.0") {
			continue
		}
		attempts++
		h.noteCodeSignatureFailure("0.109.0")
	}
	if attempts != 1 {
		t.Fatalf("expected 1 attempt across 60 heartbeats, got %d", attempts)
	}
}

// Publishing a different (correctly signed) version is the operator's fix, so
// it must be attempted on the very next heartbeat.
func TestCodeSignatureBackoff_NewTargetIsNotThrottled(t *testing.T) {
	h := &Heartbeat{}
	h.noteCodeSignatureFailure("0.109.0")
	if h.codeSignatureBackoffActive("0.109.1") {
		t.Fatal("a different target version must not inherit the cooldown")
	}
}

// Re-publishing the SAME version with a good signature must recover without
// restarting the agent.
func TestCodeSignatureBackoff_ExpiresAfterCooldown(t *testing.T) {
	h := &Heartbeat{}
	h.noteCodeSignatureFailure("0.109.0")

	h.badSignatureMu.Lock()
	h.badSignatureAt = time.Now().Add(-2 * codeSignatureRetryCooldown)
	h.badSignatureMu.Unlock()

	if h.codeSignatureBackoffActive("0.109.0") {
		t.Fatal("the cooldown must expire so a republished build recovers on its own")
	}
}

// The two cooldowns are independent: a signature failure must not silence a
// different, unrelated upgrade target refused as untrusted, or vice versa.
func TestCodeSignatureBackoff_IndependentOfUntrustedReleaseBackoff(t *testing.T) {
	h := &Heartbeat{}
	h.noteCodeSignatureFailure("0.109.0")
	if h.untrustedReleaseBackoffActive("0.109.0") {
		t.Fatal("a signature failure must not start the untrusted-release cooldown")
	}

	other := &Heartbeat{}
	other.noteUntrustedRelease("0.109.0")
	if other.codeSignatureBackoffActive("0.109.0") {
		t.Fatal("an untrusted release must not start the signature cooldown")
	}
}

// doUpgrade runs on a goroutine per heartbeat, so the state must be safe under
// concurrent access (-race makes this meaningful).
func TestCodeSignatureBackoff_ConcurrentAccess(t *testing.T) {
	h := &Heartbeat{}
	done := make(chan struct{})
	for i := 0; i < 8; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 200; j++ {
				h.noteCodeSignatureFailure("0.109.0")
				_ = h.codeSignatureBackoffActive("0.109.0")
			}
		}()
	}
	for i := 0; i < 8; i++ {
		<-done
	}
}

// doUpgrade classifies the updater's failure by sentinel. Pin that a wrapped
// ErrCodeSignatureInvalid is still recognised, and that neighbouring updater
// sentinels are not confused with it — misclassifying one as the other would
// either disable auto-update permanently or retry a doomed download forever.
func TestCodeSignatureErrorClassification(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "bare sentinel", err: updater.ErrCodeSignatureInvalid, want: true},
		{
			name: "wrapped sentinel",
			err:  fmt.Errorf("failed to replace binary: %w", updater.ErrCodeSignatureInvalid),
			want: true,
		},
		{name: "read-only filesystem", err: updater.ErrReadOnlyFS, want: false},
		{name: "text file busy", err: updater.ErrTextBusy, want: false},
		{name: "file locked", err: updater.ErrFileLocked, want: false},
		{name: "untrusted release", err: updater.ErrUntrustedRelease, want: false},
		{name: "unrelated error", err: errors.New("connection reset"), want: false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := errors.Is(tc.err, updater.ErrCodeSignatureInvalid); got != tc.want {
				t.Fatalf("errors.Is(%v, ErrCodeSignatureInvalid) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}
