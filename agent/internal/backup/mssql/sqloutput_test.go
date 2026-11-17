package mssql

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf16"
)

// serverPathOutput is sqlcmd's output for serverPathQuery when the property
// holds s: its UTF-16LE byte count, a colon, then its hex.
func serverPathOutput(s string) string {
	return fmt.Sprintf("%d:%s\n\n(1 rows affected)\n", 2*len(utf16.Encode([]rune(s))), utf16Hex(s))
}

func wrapAt(s string, width int) string {
	var b strings.Builder
	for len(s) > width {
		b.WriteString(s[:width] + "\n")
		s = s[width:]
	}
	b.WriteString(s)
	return b.String()
}

// A server path whose printed value is cut short (wrapped onto further
// lines, or truncated) is never used as a shorter path.
func TestResolveBackupTargetDirRefusesPartialServerPath(t *testing.T) {
	full := `C:\Program Files\Microsoft SQL Server\MSSQL17.SQLEXPRESS\MSSQL\Backup`
	fallback := winJoin(programDataDir(), "Breeze", "mssql-staging", "SQLEXPRESS")
	cases := map[string]string{
		"bare hex wrapped at 80":       wrapAt(utf16Hex(full), 80) + "\n\n(1 rows affected)\n",
		"length-prefixed wrapped":      wrapAt(strings.TrimSuffix(serverPathOutput(full), "\n\n(1 rows affected)\n"), 80) + "\n\n(1 rows affected)\n",
		"length-prefixed truncated":    fmt.Sprintf("%d:%s\n", 2*len(full), utf16Hex(full[:20])),
		"length larger than the value": fmt.Sprintf("%d:%s\n", 2*len(full)+2, utf16Hex(full)),
		"control character in path":    serverPathOutput("C:\\Backups\nX"),
		"bare hex, no byte count":      utf16Hex(full) + "\n",
	}
	for name, out := range cases {
		t.Run(name, func(t *testing.T) {
			resetTrustCertProbe(t)
			withMkdirAllRecorder(t)
			withRecordingIcacls(t, &recordingRunner{})
			withRecordingRunner(t, &recordingRunner{responses: []fakeResponse{{out: []byte(out)}}})
			dir, err := resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
			if err != nil {
				t.Fatal(err)
			}
			if dir != fallback {
				t.Fatalf("dir = %q, want the fallback %q", dir, fallback)
			}
		})
	}

	resetTrustCertProbe(t)
	withMkdirAllRecorder(t)
	withRecordingIcacls(t, &recordingRunner{})
	r := &recordingRunner{responses: []fakeResponse{{out: []byte(serverPathOutput(full))}}}
	withRecordingRunner(t, r)
	dir, err := resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
	if err != nil {
		t.Fatal(err)
	}
	if dir != full+`\breeze` {
		t.Fatalf("dir = %q", dir)
	}
	if !strings.Contains(r.calls[0], "DATALENGTH(") || !strings.Contains(r.calls[0], " -w 65535 ") {
		t.Fatalf("call = %q", r.calls[0])
	}
}

// A query that would not fit one Windows command line is refused with a
// clear error instead of being cut short by the OS.
func TestRunSqlcmdRefusesQueryLongerThanOneCommandLine(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{}
	withRecordingRunner(t, r)
	long := "SELECT '" + strings.Repeat("x", maxSqlcmdQueryLen) + "'"
	_, err := runSqlcmd(".", long)
	if err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("err = %v", err)
	}
	if len(r.calls) != 0 {
		t.Fatalf("sqlcmd ran with a %d-character query", len(long))
	}
	if _, err := runSqlcmd(".", "SELECT '"+strings.Repeat("x", 29000)+"'"); err != nil {
		t.Fatalf("refused a query that fits: %v", err)
	}
}

func TestValidateInstanceNameEdges(t *testing.T) {
	for _, bad := range []string{" SQLEXPRESS", "SQLEXPRESS ", ".SQLEXPRESS", "SQLEXPRESS.", "ABCDEFGHIJKLMNOPQ"} {
		if err := validateInstanceName(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	for _, ok := range []string{"ABCDEFGHIJKLMNOP", "ÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉÉ", "SQL.EXPRESS", "SQL EXPRESS"} {
		if err := validateInstanceName(ok); err != nil {
			t.Fatalf("refused %q: %v", ok, err)
		}
	}
}

// A renamed restore with many files builds a statement too long for one
// command line; it is refused with a clear error rather than sent.
func TestRenamedRestoreWithManyFilesIsRefusedNotCutShort(t *testing.T) {
	resetTrustCertProbe(t)
	var rows strings.Builder
	for i := 0; i < 60; i++ {
		fmt.Fprintf(&rows, "AssureDB_partition_%02d|D:\\SQLData\\AssureDB_%02d.ndf|D|\n", i, i)
	}
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte(rows.String())},
		{out: []byte(serverPathOutput(`D:\SQLData`))},
		{out: []byte(serverPathOutput(`L:\SQLLogs`))},
	}}
	withRecordingRunner(t, r)
	query, err := resolveRestoreQuery(`.\SQLEXPRESS`, `D:\Backups\AssureDB_full_20260909_120000.bak`, "AssureDB_restored", "AssureDB_restored", "RECOVERY")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runSqlcmd(`.\SQLEXPRESS`, query); err == nil || !strings.Contains(err.Error(), "too long") {
		t.Fatalf("err = %v (query %d characters)", err, len(query))
	}
	if len(r.calls) != 3 {
		t.Fatalf("calls = %d", len(r.calls))
	}
}
