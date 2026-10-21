package security

import (
	"maps"
	"sync"
	"time"
)

// Cadence of the Windows security-posture probes (#9267).
//
// security.CollectStatus runs on every 5-minute security tick, and on Windows
// each probe is a PowerShell spawn (+ conhost.exe). Probes whose answer rarely
// changes go through a slowProbe and are re-run at most every slowProbeTTL:
//
//	BitLocker system-drive status   Get-BitLockerVolume -MountPoint $env:SystemDrive
//	BitLocker volume details        Get-BitLockerVolume | ConvertTo-Json
//	Account password policy         Get-CimInstance Win32_AccountPolicy
//
// Probes that report state an attacker or user can toggle at any moment stay
// on the 5-minute tick: Windows Security Center products, Defender status,
// firewall profiles and local Administrators membership.
//
// BitLocker recovery-key escrow is rate-limited separately in the heartbeat
// (recoveryKeyCollectInterval) so key material is never held in a cache.
//
// The on-demand security_collect_status command uses CollectStatusFresh, which
// invalidates these caches first, so a technician never sees a stale answer.
const (
	slowProbeTTL = 30 * time.Minute
	// slowProbeErrorTTL is shorter so a transient failure (PowerShell cold
	// start after boot hitting its timeout) does not report "unknown" for the
	// full half hour, while a persistent failure (no BitLocker module on Home
	// editions) is still not re-spawned on every tick.
	slowProbeErrorTTL = 10 * time.Minute
)

// slowProbe caches the result of an expensive, rarely-changing probe.
type slowProbe[T any] struct {
	fetch func() (T, error)
	// clone copies a cached value before handing it out so callers cannot
	// mutate the cached copy. Nil means T is safe to share.
	clone func(T) T
	now   func() time.Time

	mu        sync.Mutex
	value     T
	err       error
	fetchedAt time.Time
	valid     bool
}

func newSlowProbe[T any](fetch func() (T, error)) *slowProbe[T] {
	return &slowProbe[T]{fetch: fetch, now: time.Now}
}

func newSlowMapProbe(fetch func() (map[string]any, error)) *slowProbe[map[string]any] {
	p := newSlowProbe(fetch)
	p.clone = maps.Clone[map[string]any]
	return p
}

// Get returns the cached result while it is fresh, otherwise re-runs fetch.
// The lock is held across fetch so concurrent callers (the tick and an
// on-demand command) share one spawn rather than racing two.
func (p *slowProbe[T]) Get() (T, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	now := p.now()
	ttl := slowProbeTTL
	if p.err != nil {
		ttl = slowProbeErrorTTL
	}
	if !p.valid || now.Sub(p.fetchedAt) >= ttl {
		p.value, p.err = p.fetch()
		p.fetchedAt = now
		p.valid = true
	}
	if p.clone != nil && p.err == nil {
		return p.clone(p.value), nil
	}
	return p.value, p.err
}

// Refresh re-runs the probe unconditionally and caches the result, for
// callers that need a fresh answer (CIS checks and remediation).
func (p *slowProbe[T]) Refresh() (T, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value, p.err = p.fetch()
	p.fetchedAt = p.now()
	p.valid = true
	if p.clone != nil && p.err == nil {
		return p.clone(p.value), nil
	}
	return p.value, p.err
}

// Invalidate makes the next Get re-run the probe.
func (p *slowProbe[T]) Invalidate() {
	p.mu.Lock()
	p.valid = false
	p.mu.Unlock()
}

var (
	bitLockerStatusProbe  = newSlowProbe(getEncryptionStatusWindows)
	bitLockerDetailsProbe = newSlowMapProbe(collectEncryptionDetailsWindows)
	passwordPolicyProbe   = newSlowMapProbe(collectPasswordPolicySummaryWindows)
)

func getEncryptionStatusWindowsCached() (bool, error) { return bitLockerStatusProbe.Get() }

func collectEncryptionDetailsWindowsCached() (map[string]any, error) {
	return bitLockerDetailsProbe.Get()
}

func collectPasswordPolicySummaryWindowsCached() (map[string]any, error) {
	return passwordPolicyProbe.Get()
}

func invalidateSlowPostureProbes() {
	bitLockerStatusProbe.Invalidate()
	bitLockerDetailsProbe.Invalidate()
	passwordPolicyProbe.Invalidate()
}
