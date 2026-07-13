package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Cross-language contract test for the backup exclusion-glob dialect (issue #2473).
//
// The API validates exclusion globs BEFORE persisting them and shipping them to
// the fleet. That validator (packages/shared/src/utils/backupExclusionGlob.ts) is
// a hand-port of THIS package's matcher, because the dialect is Go's stdlib
// path.Match applied per segment — not doublestar, not minimatch.
//
// A port is only safe if it is pinned. Both sides replay the SAME fixture table:
//
//	Go (here)  -> the real newExcludeMatcherForOS / matches
//	TS         -> packages/shared/src/utils/backupExclusionGlob.test.ts
//
// If the dialects ever drift apart, one of the two suites goes red. Do NOT "fix"
// a failure by editing the fixture's expectations — that silently re-opens #2473.
// If the agent's matcher is intentionally changed, update the fixture AND the TS
// port together, and expect the TS suite to catch anything you missed.

const contractFixturePath = "../../../packages/shared/src/fixtures/backup-exclusion-contract.json"

type contractFixture struct {
	Validity []struct {
		Pattern string  `json:"pattern"`
		Usable  bool    `json:"usable"`
		Problem *string `json:"problem"`
		Note    string  `json:"note"`
	} `json:"validity"`
	Matching []struct {
		Patterns        []string `json:"patterns"`
		RelPath         string   `json:"relPath"`
		CaseInsensitive bool     `json:"caseInsensitive"`
		Expected        bool     `json:"expected"`
		Note            string   `json:"note"`
	} `json:"matching"`
	MatcherPortLimitations []struct {
		Patterns        []string `json:"patterns"`
		RelPath         string   `json:"relPath"`
		CaseInsensitive bool     `json:"caseInsensitive"`
		Go              bool     `json:"go"`
		TSPort          bool     `json:"tsPort"`
		Note            string   `json:"note"`
	} `json:"matcherPortLimitations"`
}

func loadContractFixture(t *testing.T) contractFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(contractFixturePath))
	if err != nil {
		t.Fatalf("read contract fixture: %v\n"+
			"This test is the agent half of a cross-language contract; the fixture lives in the shared package.", err)
	}
	var fx contractFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse contract fixture: %v", err)
	}
	if len(fx.Validity) == 0 || len(fx.Matching) == 0 {
		t.Fatalf("contract fixture is empty (validity=%d matching=%d) — a vacuous contract test is worse than none",
			len(fx.Validity), len(fx.Matching))
	}
	return fx
}

// TestContractValidity pins WHICH PATTERNS THE AGENT WILL ACTUALLY USE.
//
// The agent never fails a backup on a bad glob — it logs and skips it. So the
// observable contract is: does this pattern survive compilation, or is it
// silently dropped? Compiling a single pattern and checking for a nil matcher is
// exactly that question, and it is precisely what the API must predict in order
// to reject a pattern instead of letting it rot in the DB.
func TestContractValidity(t *testing.T) {
	fx := loadContractFixture(t)

	for _, tc := range fx.Validity {
		t.Run(tc.Pattern+" "+tc.Note, func(t *testing.T) {
			// Case-sensitive compile: case folding cannot change SYNTACTIC validity.
			m := newExcludeMatcherForOS([]string{tc.Pattern}, false)
			compiled := m != nil

			if compiled != tc.Usable {
				verb := "DROPPED"
				if compiled {
					verb = "COMPILED"
				}
				t.Fatalf("agent %s pattern %q, but the shared contract says usable=%v (%s).\n"+
					"The API-side validator is derived from this contract — if the agent's behavior "+
					"changed, update the fixture AND packages/shared/src/utils/backupExclusionGlob.ts together.",
					verb, tc.Pattern, tc.Usable, tc.Note)
			}
		})
	}
}

// TestContractMatching pins MATCH SEMANTICS, not just validity.
//
// Validity alone would be a weak contract: it would not catch the TS port
// silently disagreeing about what "**" spans, whether a base-name pattern hits
// directories, or that '!' is a literal rather than a negation. Those are the
// cases a generic glob library gets wrong.
func TestContractMatching(t *testing.T) {
	fx := loadContractFixture(t)

	for _, tc := range fx.Matching {
		t.Run(tc.RelPath+" "+tc.Note, func(t *testing.T) {
			m := newExcludeMatcherForOS(tc.Patterns, tc.CaseInsensitive)
			// A nil matcher means "exclude nothing" — matches() is nil-safe.
			got := m.matches(tc.RelPath)

			if got != tc.Expected {
				t.Fatalf("matcher(patterns=%q, caseInsensitive=%v).matches(%q) = %v, contract expects %v (%s)",
					tc.Patterns, tc.CaseInsensitive, tc.RelPath, got, tc.Expected, tc.Note)
			}
		})
	}
}

// TestContractMatcherPortLimitations pins the KNOWN, DELIBERATE divergences of
// the TS matcher port.
//
// Go's path.Match advances the name by BYTES in its star loop, and Go's
// strings.ToLower uses simple (not full Unicode) case mapping. A code-point-based
// JS port reproduces neither. Rather than pretend the port is exact, the fixture
// records exactly where it is not.
//
// This test asserts the GO side of each documented divergence — i.e. that the
// agent really does behave the way the note claims. Without it, the "known
// limitation" note could quietly become wrong and nobody would notice. The TS
// suite asserts the other half (that the port still diverges as documented), so
// the boundary cannot silently widen either.
//
// Note this is a limitation of the MATCHER only. The API-side validator
// (describeExclusionPattern) is exhaustively exact against this same Go code.
func TestContractMatcherPortLimitations(t *testing.T) {
	fx := loadContractFixture(t)

	if len(fx.MatcherPortLimitations) == 0 {
		t.Fatal("matcherPortLimitations is empty — if the TS port became exact, remove the block " +
			"and fold these into matching[]; do not just delete the assertions")
	}

	for _, tc := range fx.MatcherPortLimitations {
		t.Run(tc.RelPath+" "+tc.Note, func(t *testing.T) {
			m := newExcludeMatcherForOS(tc.Patterns, tc.CaseInsensitive)
			got := m.matches(tc.RelPath)

			if got != tc.Go {
				t.Fatalf("agent matcher(patterns=%q, ci=%v).matches(%q) = %v, but the fixture documents "+
					"the agent's behavior as %v (%s).\nThe recorded TS-port limitation is therefore stale.",
					tc.Patterns, tc.CaseInsensitive, tc.RelPath, got, tc.Go, tc.Note)
			}
			if tc.Go == tc.TSPort {
				t.Fatalf("case %q is listed as a port LIMITATION but records go==tsPort (%v) — "+
					"if the port now agrees, move this case into matching[]", tc.Note, tc.Go)
			}
		})
	}
}
