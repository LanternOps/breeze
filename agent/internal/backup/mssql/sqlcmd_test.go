package mssql

import (
	"fmt"
	"strings"
	"testing"
)

// recordingRunner fakes sqlcmdRunner so tests can assert both the exact
// argv sent to sqlcmd and how many times it was invoked, without needing a
// real sqlcmd.exe. Modeled on the commandRunner fakes already used in this
// repo (internal/agentapp, cmd/breeze-watchdog).
type recordingRunner struct {
	calls []string

	// respond, when set, computes each call's outcome from its args. Takes
	// priority over responses.
	respond func(args []string) ([]byte, error)

	// responses are consumed in call order; the last entry repeats once
	// exhausted. Ignored when respond is set.
	responses []fakeResponse
}

type fakeResponse struct {
	out []byte
	err error
}

func (r *recordingRunner) run(name string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, strings.TrimSpace(name+" "+strings.Join(args, " ")))

	if r.respond != nil {
		return r.respond(args)
	}
	if len(r.responses) == 0 {
		return nil, nil
	}
	idx := len(r.calls) - 1
	if idx >= len(r.responses) {
		idx = len(r.responses) - 1
	}
	resp := r.responses[idx]
	return resp.out, resp.err
}

// withRecordingRunner substitutes the package's sqlcmd exec seam for the
// duration of the test, and stubs out sqlcmd.exe path resolution (PATH/
// filesystem lookups aren't meaningful on a non-Windows test runner).
func withRecordingRunner(t *testing.T, r *recordingRunner) {
	t.Helper()
	origRunner := sqlcmdRunner
	origFind := findSqlcmd
	sqlcmdRunner = r.run
	findSqlcmd = func() (string, error) { return `C:\fake\sqlcmd.exe`, nil }
	t.Cleanup(func() {
		sqlcmdRunner = origRunner
		findSqlcmd = origFind
	})
}

// resetTrustCertProbe clears the cached "-C supported" decision so each
// test starts from the same optimistic-default state, and restores it
// afterward so tests don't leak state into each other.
func resetTrustCertProbe(t *testing.T) {
	t.Helper()
	globalTrustCertProbe.reset()
	t.Cleanup(globalTrustCertProbe.reset)
}

func containsArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

// (a) backup args include -C.
func TestSqlcmdArgs_IncludesTrustCertByDefault(t *testing.T) {
	resetTrustCertProbe(t)

	args := sqlcmdArgs("SERVER", "-Q", "SELECT 1")

	if !containsArg(args, "-C") {
		t.Fatalf("expected -C (trust server certificate) in sqlcmd args, got %v", args)
	}
	if !containsArg(args, "-E") {
		t.Fatalf("expected -E (Windows auth) in sqlcmd args, got %v", args)
	}
}

// (b) a fake sqlcmd that fails with "Unknown Option '-C'" on the first call
// succeeds on the retry without -C, and the decision is cached: a second,
// independent call (standing in for "the second backup call") makes exactly
// one sqlcmd invocation and does not send -C.
func TestRunSqlcmd_FallsBackAndCachesWhenTrustCertUnsupported(t *testing.T) {
	resetTrustCertProbe(t)

	r := &recordingRunner{
		responses: []fakeResponse{
			{out: []byte("Sqlcmd: Unknown Option '-C'.\nUsage: Sqlcmd            [-S server]..."), err: fmt.Errorf("exit status 1")},
			{out: []byte("edition|\n--------|\nExpress Edition|\n")},
			{out: []byte("edition|\n--------|\nExpress Edition|\n")}, // second, independent call
		},
	}
	withRecordingRunner(t, r)

	// First call: probes -C, discovers this sqlcmd build rejects it, retries
	// without it.
	out, err := runSqlcmd(".", "SELECT 1")
	if err != nil {
		t.Fatalf("first runSqlcmd call: unexpected error: %v", err)
	}
	if out == "" {
		t.Fatal("expected non-empty output from the first call")
	}
	if len(r.calls) != 2 {
		t.Fatalf("expected 2 sqlcmd invocations for the first call (probe + retry), got %d: %v", len(r.calls), r.calls)
	}
	if !strings.Contains(r.calls[0], "-C") {
		t.Fatalf("first attempt should include -C, got %q", r.calls[0])
	}
	if strings.Contains(r.calls[1], "-C") {
		t.Fatalf("retry attempt should NOT include -C, got %q", r.calls[1])
	}

	// Second, independent call: the "unsupported" decision must be cached —
	// exactly one more sqlcmd invocation, and it must not send -C.
	if _, err := runSqlcmd(".", "SELECT 2"); err != nil {
		t.Fatalf("second runSqlcmd call: unexpected error: %v", err)
	}
	if len(r.calls) != 3 {
		t.Fatalf("expected exactly 1 additional sqlcmd invocation on the second call (3 total), got %d: %v", len(r.calls), r.calls)
	}
	if strings.Contains(r.calls[2], "-C") {
		t.Fatalf("cached decision should have skipped -C on the second call, got %q", r.calls[2])
	}
}

// (c) a fake that reproduces the real ODBC 18 behavior: it returns the
// certificate-chain error when -C is absent, and succeeds when -C is
// present. Since sqlcmdArgs sends -C by default, the very first attempt
// must succeed with no retry needed — this is D22 itself.
func TestRunSqlcmd_ODBC18RequiresTrustCert(t *testing.T) {
	resetTrustCertProbe(t)

	r := &recordingRunner{
		respond: func(args []string) ([]byte, error) {
			if containsArg(args, "-C") {
				return []byte("edition|\n--------|\nExpress Edition|\n"), nil
			}
			return []byte(`Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : SSL Provider: The certificate chain was issued by an authority that is not trusted.
Sqlcmd: Error: Microsoft ODBC Driver 18 for SQL Server : Client unable to establish connection.`), fmt.Errorf("exit status 1")
		},
	}
	withRecordingRunner(t, r)

	out, err := runSqlcmd(".", "SELECT 1")
	if err != nil {
		t.Fatalf("expected the query to succeed once -C is sent, got error: %v", err)
	}
	if out == "" {
		t.Fatal("expected non-empty output")
	}
	if len(r.calls) != 1 {
		t.Fatalf("expected exactly 1 sqlcmd call (succeeds immediately with -C), got %d: %v", len(r.calls), r.calls)
	}
}

// (d) discovery's enrichInstance (discovery.go) calls this exact runSqlcmd
// function for its SERVERPROPERTY/sys.databases queries — there is only one
// sqlcmd invocation path in this package (sqlcmdArgs), so proving a
// discovery-shaped query gets -C here proves discovery.go gets the fix too.
func TestRunSqlcmd_DiscoveryQueryIncludesTrustCert(t *testing.T) {
	resetTrustCertProbe(t)

	r := &recordingRunner{responses: []fakeResponse{{out: []byte("Edition|\n--------|\nExpress Edition|\n")}}}
	withRecordingRunner(t, r)

	if _, err := runSqlcmd(".", "SELECT SERVERPROPERTY('Edition')"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(r.calls) != 1 || !strings.Contains(r.calls[0], "-C") {
		t.Fatalf("discovery-style query must include -C, got %v", r.calls)
	}
}

// (e) the sqlcmd.exe lookup fallback list includes the ODBC-18-bundled
// location, since SQL Server 2022/2025 hosts may have only the standalone
// ODBC driver's sqlcmd (not a full SQL Server Tools install) on PATH.
func TestSqlcmdFallbackPaths_IncludesODBC180(t *testing.T) {
	want := `C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\180\Tools\Binn\SQLCMD.EXE`
	if !containsArg(sqlcmdFallbackPaths, want) {
		t.Fatalf("expected sqlcmdFallbackPaths to include %q, got %v", want, sqlcmdFallbackPaths)
	}
}
