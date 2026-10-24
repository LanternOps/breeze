package security

import (
	"errors"
	"testing"
	"time"
)

func newTestSlowProbe[T any](fetch func() (T, error)) (*slowProbe[T], *time.Time) {
	now := time.Unix(1_700_000_000, 0)
	p := newSlowProbe(fetch)
	p.now = func() time.Time { return now }
	return p, &now
}

func TestSlowProbeCachesSuccessForTTL(t *testing.T) {
	calls := 0
	p, now := newTestSlowProbe(func() (int, error) { calls++; return calls, nil })

	for range 6 { // six 5-minute security ticks
		if v, err := p.Get(); err != nil || v != 1 {
			t.Fatalf("Get = %v, %v; want cached 1", v, err)
		}
		*now = now.Add(5 * time.Minute)
		if now.Sub(time.Unix(1_700_000_000, 0)) >= slowProbeTTL {
			break
		}
	}
	if calls != 1 {
		t.Fatalf("fetches within %s = %d, want 1", slowProbeTTL, calls)
	}

	*now = time.Unix(1_700_000_000, 0).Add(slowProbeTTL)
	if v, _ := p.Get(); v != 2 {
		t.Fatalf("Get after TTL = %d, want refetched 2", v)
	}
}

func TestSlowProbeCachesErrorForShorterTTL(t *testing.T) {
	calls := 0
	boom := errors.New("Get-BitLockerVolume timed out")
	p, now := newTestSlowProbe(func() (bool, error) { calls++; return false, boom })

	if _, err := p.Get(); !errors.Is(err, boom) {
		t.Fatalf("first Get err = %v", err)
	}
	*now = now.Add(slowProbeErrorTTL - time.Second)
	if _, err := p.Get(); !errors.Is(err, boom) {
		t.Fatalf("cached Get err = %v", err)
	}
	if calls != 1 {
		t.Fatalf("fetches within error TTL = %d, want 1", calls)
	}
	*now = now.Add(time.Second)
	_, _ = p.Get()
	if calls != 2 {
		t.Fatalf("fetches after error TTL = %d, want 2", calls)
	}
	if slowProbeErrorTTL >= slowProbeTTL {
		t.Fatalf("error TTL %s must be shorter than success TTL %s", slowProbeErrorTTL, slowProbeTTL)
	}
}

func TestSlowProbeInvalidateForcesRefetch(t *testing.T) {
	calls := 0
	p, _ := newTestSlowProbe(func() (int, error) { calls++; return calls, nil })
	_, _ = p.Get()
	p.Invalidate()
	if v, _ := p.Get(); v != 2 || calls != 2 {
		t.Fatalf("Get after Invalidate = %d (calls %d), want 2", v, calls)
	}
}

// A cached details map is shared across ticks; callers must not be able to
// mutate the cached copy (CollectStatus hands it to the JSON payload, and
// collectPasswordPolicySummaryWindows used to add keys to its result).
func TestSlowProbeMapResultsAreNotAliased(t *testing.T) {
	prev := passwordPolicyProbe.fetch
	passwordPolicyProbe.fetch = func() (map[string]any, error) { return map[string]any{"minLength": 14}, nil }
	t.Cleanup(func() { passwordPolicyProbe.fetch = prev; passwordPolicyProbe.Invalidate() })
	passwordPolicyProbe.Invalidate()

	first, _ := collectPasswordPolicySummaryWindowsCached()
	first["minLength"] = 0
	second, _ := collectPasswordPolicySummaryWindowsCached()
	if second["minLength"] != 14 {
		t.Fatalf("cached map was mutated through a caller: %v", second)
	}
}

// The security-status tick reads the Windows posture probes through the
// cache: three ticks inside the TTL spawn each probe once (#9267).
func TestWindowsStatusTickUsesSlowProbes(t *testing.T) {
	counts := stubWindowsSlowProbes(t)

	for range 3 {
		if on, details, err := collectEncryptionPostureFor("windows"); err != nil || !on || details == nil {
			t.Fatalf("posture = %v, %v, %v", on, details, err)
		}
		if p, err := collectPasswordPolicySummaryForStatus("windows"); err != nil || p == nil {
			t.Fatalf("policy = %v, %v", p, err)
		}
	}
	if counts["status"] != 1 || counts["details"] != 1 || counts["policy"] != 1 {
		t.Fatalf("windows probe fetches over 3 ticks = %v, want 1 each", counts)
	}
}

// Exported/explicit reads stay fresh: CIS remediation reads the password
// policy before and after changing it, and must never see a cached value. A
// fresh read also refreshes the cache so the next status tick reports it.
func TestWindowsFreshReadsBypassAndRefreshCache(t *testing.T) {
	counts := stubWindowsSlowProbes(t)

	_, _ = collectPasswordPolicySummaryForStatus("windows")
	_, _ = collectPasswordPolicySummaryFor("windows")
	_, _ = collectPasswordPolicySummaryFor("windows")
	if counts["policy"] != 3 {
		t.Fatalf("fresh policy reads fetched %d times, want 3", counts["policy"])
	}
	_, _ = collectPasswordPolicySummaryForStatus("windows")
	if counts["policy"] != 3 {
		t.Fatalf("tick after fresh read re-fetched (%d); fresh read should refresh the cache", counts["policy"])
	}

	_, _ = getEncryptionStatusFor("windows")
	_, _ = getEncryptionStatusFor("windows")
	if counts["status"] != 2 {
		t.Fatalf("fresh encryption-status reads fetched %d times, want 2", counts["status"])
	}
}

// CollectStatusFresh (the on-demand command) must not serve cached posture.
func TestInvalidateSlowPostureProbesForcesTickRefetch(t *testing.T) {
	counts := stubWindowsSlowProbes(t)
	_, _, _ = collectEncryptionPostureFor("windows")
	_, _ = collectPasswordPolicySummaryForStatus("windows")
	invalidateSlowPostureProbes()
	_, _, _ = collectEncryptionPostureFor("windows")
	_, _ = collectPasswordPolicySummaryForStatus("windows")
	if counts["status"] != 2 || counts["details"] != 2 || counts["policy"] != 2 {
		t.Fatalf("fetches after invalidate = %v, want 2 each", counts)
	}
}

func stubWindowsSlowProbes(t *testing.T) map[string]int {
	t.Helper()
	counts := map[string]int{}
	prevS, prevD, prevP := bitLockerStatusProbe.fetch, bitLockerDetailsProbe.fetch, passwordPolicyProbe.fetch
	bitLockerStatusProbe.fetch = func() (bool, error) { counts["status"]++; return true, nil }
	bitLockerDetailsProbe.fetch = func() (map[string]any, error) {
		counts["details"]++
		return map[string]any{"source": "bitlocker"}, nil
	}
	passwordPolicyProbe.fetch = func() (map[string]any, error) {
		counts["policy"]++
		return map[string]any{"minLength": 14}, nil
	}
	invalidateSlowPostureProbes()
	t.Cleanup(func() {
		bitLockerStatusProbe.fetch, bitLockerDetailsProbe.fetch, passwordPolicyProbe.fetch = prevS, prevD, prevP
		invalidateSlowPostureProbes()
	})
	return counts
}
