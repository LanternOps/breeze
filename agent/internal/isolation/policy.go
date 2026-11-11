package isolation

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
	"github.com/breeze-rmm/agent/internal/wire"
)

// A containment policy (W12, #10100) adds scope:"any" permits to an episode's
// allowlist. The scope is the tag: the server emits it from a policy and nowhere
// else, and the journal records which revision the installed ones came from.
//
// One rule keeps those permits from widening behind the server's back:
//
//	A new generation may change the policy in any direction. At a generation
//	that has already adopted a policy, a desired state may only remove permits,
//	and only under the same revision or under none (the policy is gone).
//
// So a stale or replayed block cannot put back what was taken away, and a policy
// that is gone (no revision, no scope:"any" entries) narrows the installed rules
// through a normal verified refresh instead of being mistaken for a new episode.
// A different revision at the same generation is refused even when it only
// removes permits: the revision is a content hash, so the server bumps the
// generation with every policy change, and a different revision without one is
// a stale or out-of-order block.

// PolicyRejectReason is why a desired block carrying a policy was rejected: the
// Detail of a `policy_rejected` journal event. A closed set, never a payload value.
type PolicyRejectReason string

const (
	// PolicyRejectRevisionMissing: scope:"any" entries with no policyRevision.
	PolicyRejectRevisionMissing PolicyRejectReason = "revision_missing"
	// PolicyRejectRevisionInvalid: a policyRevision that is not a valid revision.
	PolicyRejectRevisionInvalid PolicyRejectReason = "revision_invalid"
	// PolicyRejectRevisionRegressed: a different revision with no newer generation.
	PolicyRejectRevisionRegressed PolicyRejectReason = "revision_regressed"
	// PolicyRejectGenerationNotAdvanced: a permit added with no newer generation.
	PolicyRejectGenerationNotAdvanced PolicyRejectReason = "generation_not_advanced"
	// PolicyRejectSpecInvalid: a block carrying policy content that failed
	// validation for another reason (a bad entry, an expired identity).
	PolicyRejectSpecInvalid PolicyRejectReason = "spec_invalid"
)

// maxPolicyRejections bounds the rejections remembered for dedupe.
const maxPolicyRejections = 16

// policyStamp is what a committed attempt adopts along with its allowlist.
type policyStamp struct {
	revision   string
	generation int
}

func stampOf(spec Spec) *policyStamp {
	return &policyStamp{revision: string(spec.PolicyRevision), generation: spec.Generation}
}

// adopt records the policy on j's episode and journals a change of revision.
func (p policyStamp) adopt(j *journal.Journal, now time.Time) {
	ep := j.Episode
	switch p.revision {
	case ep.PolicyRevision:
	case "":
		j.Append(now, "policy_removed", ep.IsolationID, ep.Generation, ep.PolicyRevision)
	default:
		j.Append(now, "policy_applied", ep.IsolationID, ep.Generation, p.revision)
	}
	ep.PolicyRevision = p.revision
	if p.generation > ep.PolicyGeneration {
		ep.PolicyGeneration = p.generation
	}
}

func hasAnyScope(allow []AllowEntry) bool {
	for _, e := range allow {
		if e.Scope == ScopeAny {
			return true
		}
	}
	return false
}

// policyBearing reports whether a spec says anything about a policy.
func policyBearing(s Spec) bool {
	return s.PolicyRevision != "" || hasAnyScope(s.Allow)
}

// anyScopeSubset reports whether every scope:"any" entry of want is held, exactly.
func anyScopeSubset(want, held []AllowEntry) bool {
	have := map[string]bool{}
	for _, e := range held {
		if e.Scope == ScopeAny {
			have[allowKey(e)] = true
		}
	}
	for _, e := range want {
		if e.Scope == ScopeAny && !have[allowKey(e)] {
			return false
		}
	}
	return true
}

func allowKey(e AllowEntry) string {
	b, _ := json.Marshal(e)
	return string(b)
}

// policyRefusal applies the rule above to a spec for the committed episode, and
// returns why it is refused, or "" to proceed. An older generation is not judged
// here: the state machine refuses it as stale.
func (o *op) policyRefusal(spec Spec) PolicyRejectReason {
	ep := o.j.Episode
	if ep == nil || o.state.Phase != journal.PhaseCommitted || ep.IsolationID != spec.IsolationID || spec.Generation < ep.Generation {
		return ""
	}
	adopted := ep.PolicyGeneration
	if adopted == 0 {
		adopted = ep.Generation
	}
	if spec.Generation > adopted {
		return ""
	}
	if spec.PolicyRevision != "" && ep.PolicyRevision != "" && string(spec.PolicyRevision) != ep.PolicyRevision {
		return PolicyRejectRevisionRegressed
	}
	if !anyScopeSubset(spec.Allow, ep.Allow) {
		return PolicyRejectGenerationNotAdvanced
	}
	return ""
}

// rejectPolicy journals a `policy_rejected` event, once per episode, generation
// and reason until a policy is next adopted: the server repeats a rejected block
// on every heartbeat, and the journal keeps only its newest MaxEvents. The rules
// are not touched.
func (o *op) rejectPolicy(id string, gen int, reason PolicyRejectReason) {
	id = strings.ToLower(strings.TrimSpace(id))
	if !uuidRE.MatchString(id) {
		id, gen = "", 0 // never log or journal an identity that failed validation
	}
	if gen < 1 {
		gen = 0
	}
	key := id + "|" + strconv.Itoa(gen) + "|" + string(reason)
	if _, seen := o.m.policyRejections[key]; seen {
		return
	}
	switch {
	case o.state.RulesMayExist && !activePhase(o.state.Phase):
		// An unreadable journal stands for rules that may exist with no episode;
		// replacing it here would forget them before cleanup has run.
		log.Warn("rejected a containment policy; not journalled while orphan rules await cleanup", "isolationId", id, "generation", gen, "reason", string(reason))
		return
	case o.missing && o.m.deps.Isolator.Capability().Version < 1:
		// A build that cannot isolate has nothing to report: it stays journal-free.
		log.Warn("rejected a containment policy; not journalled by a build that cannot isolate", "isolationId", id, "generation", gen, "reason", string(reason))
		return
	}
	log.Warn("rejected a containment policy", "isolationId", id, "generation", gen, "reason", string(reason))
	o.j.Append(o.now(), "policy_rejected", id, gen, string(reason))
	if err := o.save(); err != nil {
		log.Warn("could not journal a rejected containment policy", "error", err.Error())
		return
	}
	if o.m.policyRejections == nil || len(o.m.policyRejections) >= maxPolicyRejections {
		o.m.policyRejections = map[string]struct{}{}
	}
	o.m.policyRejections[key] = struct{}{}
}

// NotePolicyRejected records that a desired block carrying a policy was rejected
// before it reached the Manager. Neither the rules nor the episode change. The
// identity comes from a block that failed validation, so it is checked here.
func (m *Manager) NotePolicyRejected(ctx context.Context, id string, gen int, reason PolicyRejectReason) {
	o, err := m.begin(ctx)
	if err != nil {
		log.Warn("isolation busy; a rejected containment policy was not journalled", "error", err.Error())
		return
	}
	defer o.end()
	o.rejectPolicy(id, gen, reason)
}

// validatePolicyRevision normalises s.PolicyRevision. A present revision must be
// valid whether or not scope:"any" entries need it: read as "no policy", a
// malformed one would narrow a held policy and be journalled as a removal.
func validatePolicyRevision(s *Spec) error {
	if s.PolicyRevision == "" || s.PolicyRevision.Valid() {
		if s.PolicyRevision == "" && hasAnyScope(s.Allow) {
			return errors.New(`scope:"any" entries need a valid policyRevision`)
		}
		return nil
	}
	return errors.New("policyRevision is not a valid revision")
}

func policyRefusalEffect(reason PolicyRejectReason) *Effect {
	return &Effect{Kind: EffReport, Refusal: wire.ErrCodeIsolationInvalidSpec, Detail: "containment policy rejected: " + string(reason)}
}
