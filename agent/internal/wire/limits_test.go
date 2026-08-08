package wire

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// serverSchemaPath is the TypeScript file that declares the authoritative
// server-side cap. Relative to this package's directory.
const serverSchemaPath = "../../../apps/api/src/routes/agents/schemas.ts"

// TestMaxCommandResultBytesMatchesServerSchema pins the Go mirror to the
// literal AND to the server's declaration.
//
// The literal assertion catches a local edit; parsing the TypeScript catches
// the dangerous direction — someone raising the server cap and never touching
// the agent, which leaves the agent bounding to a stale, tighter budget (merely
// wasteful) or, if lowered, to a stale looser one, which is exactly the #3001
// failure: the agent believed it had 16 MiB of room while the server allowed
// far less, and every backup over ~2,000 files was silently rejected.
func TestMaxCommandResultBytesMatchesServerSchema(t *testing.T) {
	// The literal, spelled out: this must equal the `stdout`/`stderr` caps in
	// the server schema (5_000_000), not a rounded 5 * 1024 * 1024.
	if MaxCommandResultBytes != 5000000 {
		t.Fatalf("MaxCommandResultBytes = %d, want 5000000; if the server cap really moved, update "+
			"apps/api/src/routes/agents/schemas.ts MAX_COMMAND_RESULT_BYTES in the SAME commit",
			MaxCommandResultBytes)
	}

	path := filepath.Clean(serverSchemaPath)
	data, err := os.ReadFile(path)
	if err != nil {
		// A missing file is a failure, not a skip: this assertion is the only
		// thing tying the two sides together, and a silently skipped
		// cross-language pin is the same as no pin at all.
		t.Fatalf("cannot read the server schema at %s to verify the mirrored cap: %v", path, err)
	}

	// Anchored on the declaration keyword so a doc comment that happens to
	// contain "MAX_COMMAND_RESULT_BYTES = <number>" cannot retarget the pin onto
	// prose — which would let the real constant drift while this test kept
	// passing against a sentence.
	re := regexp.MustCompile(`export\s+const\s+MAX_COMMAND_RESULT_BYTES\s*=\s*([0-9_]+)`)
	m := re.FindSubmatch(data)
	if m == nil {
		t.Fatalf("no `export const MAX_COMMAND_RESULT_BYTES = <number>` declaration found in %s — if it was "+
			"renamed or moved, update serverSchemaPath and this pattern", path)
	}
	serverValue, err := strconv.Atoi(strings.ReplaceAll(string(m[1]), "_", ""))
	if err != nil {
		t.Fatalf("could not parse MAX_COMMAND_RESULT_BYTES value %q: %v", m[1], err)
	}
	if serverValue != MaxCommandResultBytes {
		t.Fatalf("server MAX_COMMAND_RESULT_BYTES = %d but Go MaxCommandResultBytes = %d; the agent "+
			"bounds its payloads against the Go value, so a mismatch means results are being built "+
			"to a budget the server does not honour (issue #3001)",
			serverValue, MaxCommandResultBytes)
	}
}

// TestCommandResultBudgetLeavesHeadroom guards the arithmetic rather than the
// numbers: the budget producers target must be strictly under the cap the
// server enforces, or the headroom that absorbs Go-vs-JS re-encoding
// differences is not actually there.
func TestCommandResultBudgetLeavesHeadroom(t *testing.T) {
	if CommandResultBudget >= MaxCommandResultBytes {
		t.Fatalf("CommandResultBudget (%d) must be strictly below MaxCommandResultBytes (%d)",
			CommandResultBudget, MaxCommandResultBytes)
	}
	if CommandResultBudget <= 0 {
		t.Fatalf("CommandResultBudget (%d) must be positive; headroom (%d) has swallowed the cap (%d)",
			CommandResultBudget, CommandResultHeadroom, MaxCommandResultBytes)
	}
	if got := MaxCommandResultBytes - CommandResultBudget; got != CommandResultHeadroom {
		t.Fatalf("budget/headroom/cap are inconsistent: cap-budget = %d, headroom = %d", got, CommandResultHeadroom)
	}
}
