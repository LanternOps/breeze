package heartbeat

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/hpwarrantyobserve"
)

// HP CMSL mode (#5511 observe-first amendment §1). The server sends
// hp_cmsl_mode and hp_cmsl_tiers in warranty_settings on every heartbeat that
// carries the block. They are authority only:
//
//   - in memory: never written to agent.yaml, so a restart starts off;
//   - for hpCmslAuthorityTTL after the last block that carried them: a server
//     that stops sending the block (resolver errors, a revoked canary) expires
//     it rather than leaving it standing;
//   - only as the closed values below: an unknown mode is off, an unknown tier
//     is dropped, and tiers count only at act.
//
// The persisted hp_warranty_collection_enabled flag (W02) is never authority
// for anything here: a stale true left by an older server must not start
// anything. Every HP warranty path asks hpCmslAuthority / hpCmslTierOpen.

const (
	hpCmslModeOff     = "off"
	hpCmslModeObserve = "observe"
	hpCmslModeAct     = "act"

	hpCmslAuthorityTTL = 24 * time.Hour
)

// hpCmslKnownTiers are the act tiers this agent understands.
var hpCmslKnownTiers = []string{"t0_ingest", "t1_refresh", "install"}

// hpWarrantyState is the in-memory HP warranty state. mu guards every field.
type hpWarrantyState struct {
	mu sync.Mutex
	// mode is observe or act ("" is off); tiers is set only at act.
	mode  string
	tiers []string
	// at is when the last block carrying a mode arrived; zero means never.
	at time.Time

	// The observe schedule (hp_warranty_observe.go): one run in flight at a
	// time, the last run's time and mode, and the end of the start-up delay.
	observeRunning  bool
	observeLastRun  time.Time
	observeLastMode string
	observeFirstAt  time.Time
	// observeStopping is set at shutdown; observeCancel cancels the run in
	// flight (hp_warranty_observe.go stopHpWarrantyObserve).
	observeStopping bool
	observeCancel   context.CancelFunc
	// collect and emit are seams for tests; nil means the real observer and
	// the agent-log record.
	collect func(ctx context.Context, mode string) *hpwarrantyobserve.Observation
	emit    func(*hpwarrantyobserve.Observation)
}

func (h *Heartbeat) hpNow() time.Time {
	if h.hpWarrantyNow != nil {
		return h.hpWarrantyNow()
	}
	return time.Now()
}

// parseHpCmslMode reads hp_cmsl_mode and hp_cmsl_tiers from a warranty_settings
// object, either spelling. Anything but an exact known mode is off; tiers are
// kept only at act, known and deduplicated, in the order sent.
func parseHpCmslMode(m map[string]any) (string, []string) {
	raw, ok := m["hp_cmsl_mode"]
	if !ok {
		raw = m["hpCmslMode"]
	}
	mode, _ := raw.(string)
	switch mode {
	case hpCmslModeObserve:
		return hpCmslModeObserve, nil
	case hpCmslModeAct:
	default:
		return hpCmslModeOff, nil
	}
	rawTiers, ok := m["hp_cmsl_tiers"]
	if !ok {
		rawTiers = m["hpCmslTiers"]
	}
	list, _ := rawTiers.([]any)
	var tiers []string
	for _, v := range list {
		tier, ok := v.(string)
		if ok && slices.Contains(hpCmslKnownTiers, tier) && !slices.Contains(tiers, tier) {
			tiers = append(tiers, tier)
		}
	}
	return hpCmslModeAct, tiers
}

// setHpCmslMode records the mode a heartbeat block carried, as of now.
func (h *Heartbeat) setHpCmslMode(mode string, tiers []string) {
	now := h.hpNow()
	s := &h.hpWarranty
	s.mu.Lock()
	defer s.mu.Unlock()
	if mode == hpCmslModeOff {
		s.mode, s.tiers, s.at = "", nil, now
		return
	}
	s.mode, s.tiers, s.at = mode, tiers, now
}

// hpCmslAuthority is the current mode and open tiers: off unless a block
// carrying observe or act arrived within hpCmslAuthorityTTL. The tiers are a
// copy.
func (h *Heartbeat) hpCmslAuthority() (string, []string) {
	now := h.hpNow()
	s := &h.hpWarranty
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authorityLocked(now)
}

func (s *hpWarrantyState) authorityLocked(now time.Time) (string, []string) {
	if s.mode == "" || s.at.IsZero() || now.Sub(s.at) > hpCmslAuthorityTTL {
		return hpCmslModeOff, nil
	}
	return s.mode, slices.Clone(s.tiers)
}

// hpCmslTierOpen reports whether tier may act now: a fresh act mode that lists
// it. Every act path checks this; nothing acts on the persisted flag.
func (h *Heartbeat) hpCmslTierOpen(tier string) bool {
	mode, tiers := h.hpCmslAuthority()
	return mode == hpCmslModeAct && slices.Contains(tiers, tier)
}
