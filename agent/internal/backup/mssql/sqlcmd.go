package mssql

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/procspawn"
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
	return procspawn.Command(name, args...).CombinedOutput()
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

// looksLikeTrustCertUnsupported reports whether sqlcmd's output says it
// doesn't recognize -C — as opposed to a real connection or query failure,
// or a complaint about some other option — so the caller can fall back
// instead of surfacing a spurious error to the user.
//
// A line reporting an unknown option counts only when it names -C (matched
// case-sensitively: -c is a different sqlcmd option). Output that is only
// the usage text, with no unknown-option line, still counts, as it always
// has, because it names no option at all. That case cannot be told apart
// from a build that rejects -X1 or -x; it does no harm, because those two
// are sent on every attempt, so such a build fails every call with or
// without -C.
// trustCertOption matches -C as a whole option token.
var trustCertOption = regexp.MustCompile(`(^|[^A-Za-z0-9-])-C([^A-Za-z0-9]|$)`)

func looksLikeTrustCertUnsupported(output string) bool {
	sawUnknownOption := false
	for _, line := range strings.Split(output, "\n") {
		if !strings.Contains(strings.ToLower(line), "unknown option") {
			continue
		}
		sawUnknownOption = true
		if trustCertOption.MatchString(line) {
			return true
		}
	}
	return !sawUnknownOption && strings.Contains(strings.ToLower(output), "usage: sqlcmd")
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
//
// -X1 turns off sqlcmd's own !! and ED commands (sqlcmd exits with an error
// if one is met) along with its startup script and environment-variable
// input, and -x turns off $(name) scripting-variable substitution. Nothing
// this package sends uses either: every -Q text is a T-SQL batch only.
func sqlcmdArgs(server string, extra ...string) []string {
	args := []string{"-S", server, "-E", "-X1", "-x"}
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
//
// The query must be one line of printable text (see checkSqlcmdQuery):
// sqlcmd reads its own commands only at the start of a line, so a query
// that stays on one line, and that starts with the T-SQL this package
// writes, is always handled as a single T-SQL batch.
func runSqlcmd(serverName, query string) (string, error) {
	if err := checkSqlcmdQuery(query); err != nil {
		return "", err
	}
	sqlcmdPath, err := findSqlcmd()
	if err != nil {
		return "", err
	}

	extra := []string{"-Q", query, "-W", "-w", "65535", "-h", "-1", "-s", "|"}
	firstAttempt := globalTrustCertProbe.needsProbe()

	out, cmdErr := sqlcmdRunner(sqlcmdPath, sqlcmdArgs(serverName, extra...)...)

	if firstAttempt {
		if cmdErr != nil && looksLikeTrustCertUnsupported(string(out)) {
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

// maxSqlcmdQueryLen is the longest -Q text runSqlcmd sends, in UTF-16 code
// units. A Windows command line holds at most 32,767 characters, including
// the sqlcmd path and the other arguments; this leaves room for those.
const maxSqlcmdQueryLen = 30000

// checkSqlcmdQuery refuses -Q text that is empty, is not a single line of
// printable text, or is too long to fit one Windows command line.
func checkSqlcmdQuery(query string) error {
	if strings.TrimSpace(query) == "" {
		return fmt.Errorf("sqlcmd: query is empty")
	}
	if !isPrintableText(query) {
		return fmt.Errorf("sqlcmd: query must be a single line of printable text")
	}
	if n := len(utf16.Encode([]rune(query))); n > maxSqlcmdQueryLen {
		return fmt.Errorf("sqlcmd: query is too long for one command line (%d characters, limit %d)", n, maxSqlcmdQueryLen)
	}
	return nil
}

// singleLine collapses every run of whitespace in a fixed query template to
// one space, so a template written across several lines in the source is
// sent as one line. Use it only on templates, never on text holding values.
func singleLine(query string) string {
	return strings.Join(strings.Fields(query), " ")
}

// boundNVarcharLen is the declared length, in UTF-16 code units, of every
// variable bindNVarchar declares.
const boundNVarcharLen = 4000

// tsqlVariableName matches the fixed variable names this package binds.
var tsqlVariableName = regexp.MustCompile(`^@[a-z_][a-z0-9_]*$`)

// bindNVarchar returns T-SQL that declares variable as nvarchar(4000) and
// sets it to value. The value is written as the hexadecimal form of its
// UTF-16LE encoding and cast back to nvarchar, so none of its characters
// appear in the statement text and no quoting is involved: the result is
// one line of ASCII whatever value holds. variable must be a fixed name
// written in this package.
func bindNVarchar(variable, value string) (string, error) {
	if !tsqlVariableName.MatchString(variable) {
		return "", fmt.Errorf("invalid T-SQL variable name %q", variable)
	}
	if !utf8.ValidString(value) {
		return "", fmt.Errorf("value for %s is not valid UTF-8", variable)
	}
	units := utf16.Encode([]rune(value))
	if len(units) > boundNVarcharLen {
		return "", fmt.Errorf("value for %s is longer than %d characters", variable, boundNVarcharLen)
	}
	encoded := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(encoded[2*i:], u)
	}
	return fmt.Sprintf("DECLARE %s nvarchar(%d); SET %s = CAST(0x%s AS nvarchar(%d));",
		variable, boundNVarcharLen, variable, strings.ToUpper(hex.EncodeToString(encoded)), boundNVarcharLen), nil
}

// validateInstanceName checks a SQL Server instance name before it is used.
// The name is only ever passed as an argument (sqlcmd -S, icacls) or joined
// as one component of the ProgramData staging path; it is never written
// into T-SQL or a shell command. Letters and digits (any script),
// underscore, hyphen, dot, space, dollar sign and number sign are accepted,
// up to SQL Server's 16-character limit. A leading or trailing dot or space
// is refused: Windows drops trailing ones from a path component, and "."
// and ".." would not name a directory of their own.
const maxInstanceNameLen = 16

func validateInstanceName(name string) error {
	if name == "" {
		return fmt.Errorf("instance name is required")
	}
	if utf8.RuneCountInString(name) > maxInstanceNameLen {
		return fmt.Errorf("SQL Server instance name %q is longer than %d characters", name, maxInstanceNameLen)
	}
	if strings.ContainsAny(name[:1], ". ") || strings.ContainsAny(name[len(name)-1:], ". ") {
		return fmt.Errorf("SQL Server instance name %q starts or ends with a dot or space", name)
	}
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			continue
		}
		switch r {
		case '_', '-', '.', ' ', '$', '#':
			continue
		}
		return fmt.Errorf("invalid character %q in SQL Server instance name %q", r, name)
	}
	return nil
}

// serverPathQuery returns a query that prints the nvarchar server property
// as "<byte count>:<hex of its UTF-16LE bytes>" (CONVERT style 2, no 0x
// prefix). sqlcmd prints text in the console code page, which can alter
// non-ASCII characters; hex does not depend on it. The byte count is taken
// from the full value, so a value that was cut short anywhere (by the
// nvarchar(1024) cast, or by line wrapping in the output) no longer matches
// it and is refused by parseServerPathOutput. The bounded varchar/varbinary
// types keep the value clear of sqlcmd's display limit for (max) types.
func serverPathQuery(property string) string {
	return fmt.Sprintf("SELECT CAST(DATALENGTH(CAST(SERVERPROPERTY('%[1]s') AS nvarchar(4000))) AS varchar(10)) + ':' + "+
		"CONVERT(varchar(4096), CAST(CAST(SERVERPROPERTY('%[1]s') AS nvarchar(1024)) AS varbinary(2048)), 2)", property)
}

// parseServerPathOutput decodes one "<byte count>:<hex>" value printed by
// serverPathQuery, refusing it unless the hex holds exactly that many bytes.
func parseServerPathOutput(value string) (string, error) {
	countText, encoded, ok := strings.Cut(strings.TrimSpace(value), ":")
	if !ok {
		return "", fmt.Errorf("value has no byte count")
	}
	count, err := strconv.Atoi(countText)
	if err != nil || count < 0 {
		return "", fmt.Errorf("invalid byte count %q", countText)
	}
	if len(encoded) != 2*count {
		return "", fmt.Errorf("value holds %d hex digits, want %d", len(encoded), 2*count)
	}
	return decodeUTF16LEHex(encoded)
}

// decodeUTF16LEHex decodes the hex of a UTF-16LE string, as printed by
// serverPathQuery. It refuses anything that is not whole, correctly paired
// UTF-16 code units.
func decodeUTF16LEHex(value string) (string, error) {
	value = strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(value), "0x"), "0X")
	raw, err := hex.DecodeString(value)
	if err != nil {
		return "", fmt.Errorf("not hex: %w", err)
	}
	if len(raw)%2 != 0 {
		return "", fmt.Errorf("odd byte count %d", len(raw))
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(raw[2*i:])
	}
	for i := 0; i < len(units); i++ {
		switch u := units[i]; {
		case u >= 0xD800 && u <= 0xDBFF:
			if i+1 >= len(units) || units[i+1] < 0xDC00 || units[i+1] > 0xDFFF {
				return "", fmt.Errorf("unpaired surrogate")
			}
			i++
		case u >= 0xDC00 && u <= 0xDFFF:
			return "", fmt.Errorf("unpaired surrogate")
		}
	}
	return string(utf16.Decode(units)), nil
}

// queryServerPath reads one of the instance's default directories
// (InstanceDefaultBackupPath, InstanceDefaultDataPath,
// InstanceDefaultLogPath) through serverPathQuery. A NULL, empty,
// undecodable or non-printable value is an error.
func queryServerPath(serverName, property string) (string, error) {
	out, err := runSqlcmd(serverName, serverPathQuery(property))
	if err != nil {
		return "", fmt.Errorf("resolve %s: %w", property, err)
	}
	if containsSqlError(out) {
		return "", fmt.Errorf("resolve %s: %s", property, extractSqlError(out))
	}
	encoded := parseSqlcmdSingleValue(out)
	if encoded == "" || strings.EqualFold(encoded, "NULL") {
		return "", fmt.Errorf("resolve %s: returned no usable value", property)
	}
	value, err := parseServerPathOutput(encoded)
	if err != nil {
		return "", fmt.Errorf("resolve %s: %v", property, err)
	}
	if value == "" || !isPrintableText(value) {
		return "", fmt.Errorf("resolve %s: returned no usable value", property)
	}
	return value, nil
}
