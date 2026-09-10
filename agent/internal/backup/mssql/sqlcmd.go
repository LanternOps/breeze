package mssql

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
)

// This file holds the sqlcmd invocation plumbing shared by backup.go,
// restore.go, and discovery.go's enrichInstance. It carries no build tag
// (unlike those three, which are windows-only) so the argument-construction
// and trust-cert fallback logic below has real unit test coverage on every
// platform, even though sqlcmd itself only ever runs on Windows.

// commandRunner runs an external command and returns its combined output.
// Production code uses execCommandRunner; tests substitute a recorder so
// the exact sqlcmd argv can be asserted without a real sqlcmd.exe.
type commandRunner func(name string, args ...string) ([]byte, error)

// execCommandRunner is the production commandRunner.
func execCommandRunner(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// sqlcmdRunner is the exec seam used by runSqlcmd. Tests replace it.
var sqlcmdRunner commandRunner = execCommandRunner

// trustCertProbe caches, per process, whether the local sqlcmd build
// recognizes -C (trust server certificate).
//
// SQL Server 2022+ ships sqlcmd built on ODBC Driver 18, which defaults to
// Encrypt=Mandatory with certificate validation. SQL Server itself uses a
// self-signed certificate by default, so every connection fails with
// "SSL Provider: The certificate chain was issued by an authority that is
// not trusted" unless -C is passed (D22). Older sqlcmd builds (ODBC 17/v15
// and the legacy 13.x tools) don't recognize -C at all and exit with a
// usage error before ever attempting to connect, so we optimistically send
// -C on the first call and fall back to omitting it — permanently, for the
// rest of the process — the moment sqlcmd itself tells us it doesn't know
// the flag.
type trustCertProbe struct {
	mu        sync.Mutex
	probed    bool
	supported bool
}

// enabled reports whether -C should be sent on the next sqlcmd invocation:
// optimistically true until proven otherwise.
func (p *trustCertProbe) enabled() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.probed {
		return true
	}
	return p.supported
}

// needsProbe reports whether the very first sqlcmd call of the process
// still needs to happen — the fallback probe only ever runs once.
func (p *trustCertProbe) needsProbe() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return !p.probed
}

func (p *trustCertProbe) recordSupported() {
	p.mu.Lock()
	p.probed = true
	p.supported = true
	p.mu.Unlock()
}

func (p *trustCertProbe) recordUnsupported() {
	p.mu.Lock()
	p.probed = true
	p.supported = false
	p.mu.Unlock()
}

// reset clears cached probe state. Test-only.
func (p *trustCertProbe) reset() {
	p.mu.Lock()
	p.probed = false
	p.supported = false
	p.mu.Unlock()
}

var globalTrustCertProbe trustCertProbe

// looksLikeUnknownOptionError reports whether sqlcmd's output indicates it
// doesn't recognize an option we passed — as opposed to a real connection
// or query failure — so the caller can fall back instead of surfacing a
// spurious error to the user.
func looksLikeUnknownOptionError(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "unknown option") || strings.Contains(lower, "usage: sqlcmd")
}

// sqlcmdArgs returns the sqlcmd invocation arguments for connecting to
// server via Windows Authentication, trusting the server's certificate
// (-C) when the local sqlcmd build supports it, followed by extra (the
// query and output-formatting flags). Every sqlcmd call in this package
// builds its argument list here, so RunBackup, ListBackups, RunRestore,
// VerifyBackup, and discovery's enrichInstance all invoke sqlcmd
// identically.
//
// -C is safe in this context: every connection this package makes is local
// (named pipes/shared memory over "." or ".\<instance>"), so trusting the
// server's own self-signed certificate adds no real exposure.
func sqlcmdArgs(server string, extra ...string) []string {
	args := []string{"-S", server, "-E"}
	if globalTrustCertProbe.enabled() {
		args = append(args, "-C")
	}
	return append(args, extra...)
}

// runSqlcmd executes a T-SQL query via sqlcmd and returns its output.
//
// On the first call of the process it sends -C. If sqlcmd itself rejects
// the flag (an older build), it retries once without -C and caches that
// decision for every subsequent call — see trustCertProbe.
func runSqlcmd(serverName, query string) (string, error) {
	sqlcmdPath, err := findSqlcmd()
	if err != nil {
		return "", err
	}

	extra := []string{"-Q", query, "-W", "-h", "-1", "-s", "|"}
	firstAttempt := globalTrustCertProbe.needsProbe()

	out, cmdErr := sqlcmdRunner(sqlcmdPath, sqlcmdArgs(serverName, extra...)...)

	if firstAttempt {
		if cmdErr != nil && looksLikeUnknownOptionError(string(out)) {
			globalTrustCertProbe.recordUnsupported()
			out, cmdErr = sqlcmdRunner(sqlcmdPath, sqlcmdArgs(serverName, extra...)...)
		} else {
			globalTrustCertProbe.recordSupported()
		}
	}

	if cmdErr != nil {
		return "", fmt.Errorf("sqlcmd: %w: %s", cmdErr, string(out))
	}

	return string(out), nil
}

// sqlcmdFallbackPaths lists sqlcmd.exe install locations to probe when it
// is not on PATH, newest-first. SQL Server ships its own sqlcmd under
// "Microsoft SQL Server\<version>\Tools\Binn"; the ODBC driver additionally
// ships a standalone sqlcmd under "Client SDK\ODBC\<version>\Tools\Binn"
// that can be present without a full SQL Server Tools install (e.g. a
// management workstation with only the ODBC 18 driver, or a SQL Server
// 2022+/2025 install where only the ODBC-bundled sqlcmd was set up).
var sqlcmdFallbackPaths = []string{
	`C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\180\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\170\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\130\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\170\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\160\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\150\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\140\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\130\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\120\Tools\Binn\SQLCMD.EXE`,
	`C:\Program Files\Microsoft SQL Server\110\Tools\Binn\SQLCMD.EXE`,
}

// findSqlcmd resolves the path to sqlcmd.exe. It is a package var (not a
// plain func) so tests can stub it out — the real lookup depends on PATH
// and the filesystem, neither of which is meaningful to fake on a non-
// Windows test runner.
var findSqlcmd = defaultFindSqlcmd

// parseSqlcmdSingleValue extracts the first non-empty line from sqlcmd
// output that isn't a header separator ("---") or a row-count message
// ("(1 rows affected)") — the shape of any single-column, single-row
// sqlcmd query run through runSqlcmd. Shared by discovery.go's
// enrichInstance and backupcompression.go/backuptarget.go's SERVERPROPERTY
// queries.
//
// Callers that use this to pull out a value meant for further use (as
// opposed to just logging it) must check containsSqlError(output) first:
// a T-SQL error rides home on a successful (err == nil) sqlcmd exit just
// like a real result does, and its "Msg NNNN, Level ..." line doesn't
// start with "-" or "(" either, so this function alone can't tell a
// SERVERPROPERTY value apart from an error message.
func parseSqlcmdSingleValue(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" && !strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "(") {
			return line
		}
	}
	return ""
}

// containsSqlError checks sqlcmd output for error indicators.
func containsSqlError(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "msg ") && strings.Contains(lower, "level ") && strings.Contains(lower, "state ")
}

// extractSqlError pulls the first error message from sqlcmd output.
func extractSqlError(output string) string {
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		lower := strings.ToLower(line)
		if strings.Contains(lower, "msg ") && strings.Contains(lower, "level ") {
			return line
		}
	}
	return "unknown SQL error"
}

// defaultFindSqlcmd locates sqlcmd.exe on PATH or in known install
// directories.
func defaultFindSqlcmd() (string, error) {
	// Try PATH first.
	if path, err := exec.LookPath("sqlcmd.exe"); err == nil {
		return path, nil
	}

	for _, p := range sqlcmdFallbackPaths {
		if _, statErr := exec.LookPath(p); statErr == nil {
			return p, nil
		}
	}

	return "", ErrSqlcmdNotFound
}
