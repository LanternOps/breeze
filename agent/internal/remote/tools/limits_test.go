package tools

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// sharedReadCapPath is the TypeScript file that mirrors maxFileReadSize for the
// web layer. Relative to this package's directory.
const sharedReadCapPath = "../../../../packages/shared/src/constants/agentFileTransfer.ts"

// TestMaxFileReadSizeMatchesSharedConstant pins maxFileReadSize to the literal
// AND to the mirror the browser reads.
//
// The mirror exists so the File Browser can refuse an over-cap download before
// making a request (the directory listing already knows each entry's size).
// That pre-flight is only honest while the two numbers agree: if the agent cap
// moved and this mirror did not, the UI would either wave through a download
// the device then refuses, or block one the device would happily serve. Both
// read to a technician as "the file browser is broken", which is exactly the
// confusion this pin exists to prevent.
//
// Parsing the TypeScript catches the dangerous direction — raising the Go cap
// and never touching the web constant.
func TestMaxFileReadSizeMatchesSharedConstant(t *testing.T) {
	// The literal, spelled out, so a local edit fails here first.
	if maxFileReadSize != 1024*1024 {
		t.Fatalf("maxFileReadSize = %d, want %d; it is mirrored by AGENT_MAX_FILE_READ_BYTES in "+
			"packages/shared/src/constants/agentFileTransfer.ts — change both sides in the SAME commit",
			maxFileReadSize, 1024*1024)
	}

	path := filepath.Clean(sharedReadCapPath)
	data, err := os.ReadFile(path)
	if err != nil {
		// A missing file is a failure, not a skip: this assertion is the only
		// thing tying the two sides together, and a silently skipped
		// cross-language pin is the same as no pin at all.
		t.Fatalf("cannot read the shared constant at %s to verify the mirrored cap: %v", path, err)
	}

	// Anchored on the declaration keyword so the doc comment above it — which
	// legitimately discusses other byte caps — cannot retarget the pin onto prose.
	re := regexp.MustCompile(`export\s+const\s+AGENT_MAX_FILE_READ_BYTES\s*=\s*([0-9_*\s]+?);`)
	m := re.FindSubmatch(data)
	if m == nil {
		t.Fatalf("no `export const AGENT_MAX_FILE_READ_BYTES = <expr>;` declaration found in %s — if it "+
			"was renamed or moved, update sharedReadCapPath and this pattern", path)
	}

	sharedValue, err := evalByteProduct(string(m[1]))
	if err != nil {
		t.Fatalf("could not parse AGENT_MAX_FILE_READ_BYTES value %q: %v", m[1], err)
	}
	if sharedValue != maxFileReadSize {
		t.Fatalf("shared AGENT_MAX_FILE_READ_BYTES = %d but Go maxFileReadSize = %d; the web layer "+
			"pre-flights downloads against the shared value, so a mismatch means the UI is enforcing "+
			"a limit the agent does not",
			sharedValue, maxFileReadSize)
	}
}

// TestMaxFileReadSizeFitsCommandResultBudget guards the reason the read cap is
// far below the write cap: a file_read result is base64-encoded inline into the
// command result's `stdout`, which the server bounds at MAX_COMMAND_RESULT_BYTES
// (5,000,000). base64 inflates by 4/3, so the cap must leave room for the
// encoded form plus the surrounding JSON envelope. Raising maxFileReadSize past
// that ceiling would not produce a clean "file too large" error — it would
// produce a rejected frame and a 30-second command timeout instead.
func TestMaxFileReadSizeFitsCommandResultBudget(t *testing.T) {
	const serverResultCap = 5000000
	encoded := (maxFileReadSize + 2) / 3 * 4
	if encoded >= serverResultCap {
		t.Fatalf("maxFileReadSize = %d encodes to %d base64 bytes, which does not fit the server's "+
			"%d-byte command-result cap; a file_read at this size would be rejected as an oversized "+
			"frame rather than failing cleanly. Add a chunked transfer path before raising the cap.",
			maxFileReadSize, encoded, serverResultCap)
	}
}

// evalByteProduct evaluates the small `A * B` integer products these mirrored
// byte constants are written as (e.g. `1024 * 1024`), so the pin reads the
// declaration as authored instead of forcing it to be a bare literal.
func evalByteProduct(expr string) (int, error) {
	product := 1
	for _, part := range strings.Split(expr, "*") {
		n, err := strconv.Atoi(strings.ReplaceAll(strings.TrimSpace(part), "_", ""))
		if err != nil {
			return 0, err
		}
		product *= n
	}
	return product, nil
}
