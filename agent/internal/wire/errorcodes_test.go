package wire

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// TestCommandErrorCodesMatchServerSchema pins the Go error-code enum to the
// server's AGENT_COMMAND_ERROR_CODES array (#4026), the same way
// TestMaxCommandResultBytesMatchesServerSchema pins the size cap.
//
// A code added here but not on the server is classified by the API's prose
// fallback (or a 500) instead of by its typed meaning; a code added on the
// server but never emitted is dead mapping. Either one-sided edit fails here
// (and in schemas.commandResult.test.ts for the other direction).
func TestCommandErrorCodesMatchServerSchema(t *testing.T) {
	path := filepath.Clean(serverSchemaPath)
	data, err := os.ReadFile(path)
	if err != nil {
		// A missing file is a failure, not a skip: a silently skipped
		// cross-language pin is the same as no pin at all.
		t.Fatalf("cannot read the server schema at %s to verify the mirrored error codes: %v", path, err)
	}

	block := regexp.MustCompile(`(?s)export\s+const\s+AGENT_COMMAND_ERROR_CODES\s*=\s*\[(.*?)\]\s*as\s+const`).FindSubmatch(data)
	if block == nil {
		t.Fatalf("no `export const AGENT_COMMAND_ERROR_CODES = [...] as const` declaration found in %s", path)
	}
	var server []string
	for _, m := range regexp.MustCompile(`'([a-z0-9_]+)'`).FindAllSubmatch(block[1], -1) {
		server = append(server, string(m[1]))
	}
	if len(server) == 0 {
		t.Fatalf("AGENT_COMMAND_ERROR_CODES in %s parsed to an empty list", path)
	}

	var agent []string
	seen := map[CommandErrorCode]bool{}
	for _, c := range AllCommandErrorCodes {
		if seen[c] {
			t.Fatalf("duplicate code %q in AllCommandErrorCodes", c)
		}
		seen[c] = true
		agent = append(agent, string(c))
	}

	sort.Strings(server)
	sort.Strings(agent)
	if strings.Join(server, ",") != strings.Join(agent, ",") {
		t.Fatalf("agent error codes drifted from the server schema\n  agent:  %v\n  server: %v\n"+
			"update agent/internal/wire/errorcodes.go and apps/api/src/routes/agents/schemas.ts "+
			"AGENT_COMMAND_ERROR_CODES in the SAME commit", agent, server)
	}
}

// TestAllCommandErrorCodesListsEveryConstant guards against a constant that is
// declared but never added to AllCommandErrorCodes — the cross-language pin
// above compares the list, not the declarations.
func TestAllCommandErrorCodesListsEveryConstant(t *testing.T) {
	data, err := os.ReadFile("errorcodes.go")
	if err != nil {
		t.Fatalf("read errorcodes.go: %v", err)
	}
	decls := regexp.MustCompile(`(?m)^\s*ErrCode\w+\s+CommandErrorCode\s*=\s*"([a-z0-9_]+)"`).FindAllSubmatch(data, -1)
	if len(decls) == 0 {
		t.Fatal("no CommandErrorCode constants found in errorcodes.go")
	}
	listed := map[string]bool{}
	for _, c := range AllCommandErrorCodes {
		listed[string(c)] = true
	}
	for _, d := range decls {
		if !listed[string(d[1])] {
			t.Errorf("constant %q is declared but missing from AllCommandErrorCodes", d[1])
		}
	}
	if len(decls) != len(AllCommandErrorCodes) {
		t.Errorf("%d constants declared but AllCommandErrorCodes has %d entries", len(decls), len(AllCommandErrorCodes))
	}
}
