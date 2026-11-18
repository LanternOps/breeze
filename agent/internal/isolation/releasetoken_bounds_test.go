package isolation

import (
	"fmt"
	"testing"
	"time"
)

// Follow-ups to the #10102 review (#10103).

// The validity cap is compared in whole seconds. A window so large that it
// overflows time.Duration must be refused, not wrap into a small one.
func TestReleaseTokenValidityCapDoesNotOverflow(t *testing.T) {
	f := loadReleaseTokenVectors(t)
	priv, pub := vectorKey(t, f, "a")
	b := vectorBinding(f)
	now := time.Unix(f.Context.Now, 0)
	nbf := now.Add(-time.Minute).Unix()
	for _, window := range []int64{
		int64(ReleaseTokenMaxValidity/time.Second) + 1,
		9223372037,  // ×1e9 wraps past math.MaxInt64 into a negative Duration
		18446744074, // ×1e9 wraps to a small positive Duration
	} {
		t.Run(fmt.Sprint(window), func(t *testing.T) {
			payload := fmt.Sprintf(`{"v":1,"iid":%q,"gen":%d,"dev":%q,"nbf":%d,"exp":%d}`, b.IsolationID, b.Generation, b.DeviceID, nbf, nbf+window)
			err := VerifyReleaseToken(signTestToken(priv, payload), pub, b, now, time.Time{})
			if got := ReleaseTokenRejectReason(err); got != ReleaseTokenValidityTooLong {
				t.Fatalf("reason = %q (%v), want %q", got, err, ReleaseTokenValidityTooLong)
			}
		})
	}
	// Exactly the cap is still accepted.
	payload := fmt.Sprintf(`{"v":1,"iid":%q,"gen":%d,"dev":%q,"nbf":%d,"exp":%d}`, b.IsolationID, b.Generation, b.DeviceID, nbf, nbf+int64(ReleaseTokenMaxValidity/time.Second))
	if err := VerifyReleaseToken(signTestToken(priv, payload), pub, b, now, time.Time{}); err != nil {
		t.Fatalf("a 24 h window was refused: %v", err)
	}
}

// A device clock that runs slow must not refuse a current token while the
// journal already holds a later trusted time (a server Date header).
func TestReleaseTokenNotYetValidUsesHighWater(t *testing.T) {
	f := loadReleaseTokenVectors(t)
	priv, pub := vectorKey(t, f, "a")
	b := vectorBinding(f)
	real := time.Unix(f.Context.Now, 0)
	slow := real.Add(-time.Hour)
	token := mintTestToken(priv, b.IsolationID, b.Generation, b.DeviceID, real.Add(-time.Minute), real.Add(2*time.Hour))
	if err := VerifyReleaseToken(token, pub, b, slow, real); err != nil {
		t.Fatalf("slow device clock with a current high-water time: %v", err)
	}
	// Without a later trusted time the slow clock still refuses it, as before.
	if got := ReleaseTokenRejectReason(VerifyReleaseToken(token, pub, b, slow, time.Time{})); got != ReleaseTokenNotYetValid {
		t.Fatalf("no high-water: reason = %q", got)
	}
	// A token that is not yet valid against both clocks stays refused.
	future := mintTestToken(priv, b.IsolationID, b.Generation, b.DeviceID, real.Add(time.Hour), real.Add(3*time.Hour))
	if got := ReleaseTokenRejectReason(VerifyReleaseToken(future, pub, b, slow, real)); got != ReleaseTokenNotYetValid {
		t.Fatalf("future token: reason = %q", got)
	}
}
