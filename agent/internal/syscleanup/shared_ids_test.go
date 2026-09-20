package syscleanup

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The agent catalogue and the shared TS validator are two copies of one list.
// Keeping them in step by review has never worked in this repo (the cascade
// registries are the canonical example: contract tests 5/5, review 0/5), so
// this test reads the TypeScript source directly — the same technique
// apps/api/src/services/partnerTrust.test.ts uses in the other direction.
//
// It is skipped rather than failed when the file is absent so the Go package
// stays independently testable before the shared validator lands (Task 9);
// once it exists, drift is a hard failure.
func TestSharedValidatorIDsMatchTheCatalogue(t *testing.T) {
	// internal/syscleanup -> internal -> agent -> repo root
	path := filepath.Join("..", "..", "..", "packages", "shared", "src", "validators", "systemCleanup.ts")
	source, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("shared validator not present yet (%v) — Task 9 adds it", err)
	}

	block := regexp.MustCompile(`(?s)SYSTEM_CLEANUP_ACTION_IDS\s*=\s*\[(.*?)\]\s*as const`).FindSubmatch(source)
	if block == nil {
		t.Fatalf("could not find `SYSTEM_CLEANUP_ACTION_IDS = [ … ] as const` in %s", path)
	}
	found := regexp.MustCompile(`'([a-z0-9_:]+)'`).FindAllSubmatch(block[1], -1)
	if len(found) != len(ActionIDs) {
		t.Fatalf("shared validator lists %d ids, Go catalogue has %d", len(found), len(ActionIDs))
	}
	for i, match := range found {
		if got := string(match[1]); got != ActionIDs[i] {
			t.Fatalf("id %d: shared validator has %q, Go catalogue has %q", i, got, ActionIDs[i])
		}
	}
}
