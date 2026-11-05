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
//	that has already adopted a policy, a desired state may only remove permits.
//
// So a stale or replayed block cannot put back what was taken away, and a policy
// that is gone (no revision, no scope:"any" entries) narrows the installed rules
// through a normal verified refresh instead of being mistaken for a new episode.

// Why a desired block carrying a policy was rejected: the Detail of a
// `policy_rejected` journal event. A closed set, never a payload value.
const (
	// PolicyRejectRevisionMissing: scope:"any" entries with no policyRevision.
	PolicyRejectRevisionMissing = "revision_missing"
	// PolicyRejectRevisionInvalid: a policyRevision that is not a valid revision.
	PolicyRejectRevisionInvalid = "revision_invalid"
	// PolicyRejectRevisionRegressed: a different revision with no newer generation.
	PolicyRejectRevisionRegressed = "revision_regressed"
	// PolicyRejectGenerationNotAdvanced: a permit added with no newer generation.
	PolicyRejectGenerationNotAdvanced = "generation_not_advanced"
	// PolicyRejectSpecInvalid: the block failed validation for another reason.
	PolicyRejectSpecInvalid = "spec_invalid"
)

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
func (o *op) policyRefusal(spec Spec) string {
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
// and reason: the server repeats a rejected block on every heartbeat, and the
// journal keeps only its newest MaxEvents. The rules are not touched.
func (o *op) rejectPolicy(id string, gen int, reason string) {
	log.Warn("rejected a containment policy", "isolationId", id, "generation", gen, "reason", reason)
	id = strings.ToLower(strings.TrimSpace(id))
	if !uuidRE.MatchString(id) {
		id, gen = "", 0
	}
	if gen < 1 {
		gen = 0
	}
	key := id + "|" + strconv.Itoa(gen) + "|" + reason
	if o.m.lastPolicyRejection == key {
		return
	}
	// An unreadable journal stands for rules that may exist with no episode;
	// replacing it here would forget them before cleanup has run.
	if o.state.RulesMayExist && !activePhase(o.state.Phase) {
		return
	}
	// A build that cannot isolate has nothing to report: it stays journal-free.
	if o.missing && o.m.deps.Isolator.Capability().Version < 1 {
		return
	}
	o.j.Append(o.now(), "policy_rejected", id, gen, reason)
	if err := o.save(); err != nil {
		log.Warn("could not journal a rejected containment policy", "error", err.Error())
		return
	}
	o.m.lastPolicyRejection = key
}

// NotePolicyRejected records that a desired block carrying a policy was rejected
// before it reached the Manager. Neither the rules nor the episode change. The
// identity comes from a block that failed validation, so it is checked here.
func (m *Manager) NotePolicyRejected(ctx context.Context, id string, gen int, reason string) {
	o, err := m.begin(ctx)
	if err != nil {
		log.Warn("isolation busy; a rejected containment policy was not journalled", "error", err.Error())
		return
	}
	defer o.end()
	o.rejectPolicy(id, gen, reason)
}

// validatePolicyRevision normalises s.PolicyRevision: scope:"any" entries need a
// valid one, and anything else that is not valid is treated as no policy.
func validatePolicyRevision(s *Spec) error {
	if s.PolicyRevision.Valid() {
		return nil
	}
	if hasAnyScope(s.Allow) {
		return errors.New(`scope:"any" entries need a valid policyRevision`)
	}
	s.PolicyRevision = ""
	return nil
}

func policyRefusalEffect(reason string) *Effect {
	return &Effect{Kind: EffReport, Refusal: wire.ErrCodeIsolationInvalidSpec, Detail: "containment policy rejected: " + reason}
}
