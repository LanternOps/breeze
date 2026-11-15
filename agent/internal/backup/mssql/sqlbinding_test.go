package mssql

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"testing"
	"unicode/utf16"
)

// utf16Hex is the hex form of s's UTF-16LE encoding, as SQL Server's
// CONVERT(varchar, <varbinary>, 2) prints an nvarchar value.
func utf16Hex(s string) string {
	units := utf16.Encode([]rune(s))
	b := make([]byte, 2*len(units))
	for i, u := range units {
		binary.LittleEndian.PutUint16(b[2*i:], u)
	}
	return strings.ToUpper(hex.EncodeToString(b))
}

// boundValues returns every variable a statement binds, decoded.
func boundValues(t *testing.T, query string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, m := range regexp.MustCompile(`SET (@[a-z0-9_]+) = CAST\(0x([0-9A-F]*) AS nvarchar\(4000\)\)`).FindAllStringSubmatch(query, -1) {
		raw, err := hex.DecodeString(m[2])
		if err != nil || len(raw)%2 != 0 {
			t.Fatalf("binding %q: %v", m[2], err)
		}
		units := make([]uint16, len(raw)/2)
		for i := range units {
			units[i] = binary.LittleEndian.Uint16(raw[2*i:])
		}
		out[m[1]] = string(utf16.Decode(units))
	}
	return out
}

// moveTargets returns logical name -> physical path for every MOVE clause,
// resolving bound variables.
func moveTargets(t *testing.T, query string) map[string]string {
	t.Helper()
	vals := boundValues(t, query)
	out := map[string]string{}
	for _, m := range regexp.MustCompile(`MOVE (@[a-z0-9_]+) TO (@[a-z0-9_]+)`).FindAllStringSubmatch(query, -1) {
		logical, ok1 := vals[m[1]]
		path, ok2 := vals[m[2]]
		if !ok1 || !ok2 {
			t.Fatalf("MOVE %s TO %s is not bound in %q", m[1], m[2], query)
		}
		out[logical] = path
	}
	return out
}

// Values read back from the backup's file list and from the server's
// default paths are bound to variables, never written into the statement.
func TestResolveRestoreQueryBindsFileListValuesOutsideStatementText(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("Assure'DB\rX|D:\\SQLData\\AssureDB.mdf|D|\nAssureDB_log|D:\\SQLData\\AssureDB_log.ldf|L|\n\n(2 rows affected)\n")},
		{out: []byte(serverPathOutput(`D:\Données\SQL\`))},
		{out: []byte(serverPathOutput(`L:\Журнал`))},
	}}
	withRecordingRunner(t, r)

	query, err := resolveRestoreQuery(`.\SQLEXPRESS`, `D:\Backups\AssureDB_full_20260909_120000.bak`, "AssureDB_restored", "AssureDB_restored", "RECOVERY")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if err := checkSqlcmdQuery(query); err != nil {
		t.Fatalf("statement is not one printable line: %v: %q", err, query)
	}
	for _, text := range []string{"Assure'", "Assure''", "Données", "Журнал", "SQLData"} {
		if strings.Contains(query, text) {
			t.Fatalf("statement carries %q: %q", text, query)
		}
	}
	got := moveTargets(t, query)
	want := map[string]string{
		"Assure'DB\rX": `D:\Données\SQL\AssureDB_restored_Assure_DB_X.mdf`,
		"AssureDB_log": `L:\Журнал\AssureDB_restored_AssureDB_log.ldf`,
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("MOVE targets = %q, want %q", got, want)
	}
	for _, call := range r.calls[1:] {
		if !strings.Contains(call, "CONVERT(varchar(4096), CAST(CAST(SERVERPROPERTY(") {
			t.Fatalf("default path is not read as hex: %q", call)
		}
	}
}

// The BACKUP statement reads its target file from the bound variable too.
func TestExecuteBackupStatementBindsBackupFile(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{}
	withRecordingRunner(t, r)
	p := `C:\Backups\o'brien\TestDB_full_20260101_000000.bak`
	if _, _, err := executeBackupStatement(".", "TestDB", p, "full", false); err != nil {
		t.Fatal(err)
	}
	if len(r.calls) != 1 || strings.Contains(r.calls[0], "brien") || !strings.Contains(r.calls[0], "BACKUP DATABASE [TestDB] TO DISK=@backup_file WITH INIT, STATS=10") {
		t.Fatalf("calls = %q", r.calls)
	}
	if got := boundValues(t, r.calls[0])["@backup_file"]; got != p {
		t.Fatalf("bound %q, want %q", got, p)
	}
}

// The server's default backup directory is read as the hex of its UTF-16LE
// form, so a non-ASCII directory survives the console code page.
func TestResolveBackupTargetDirReadsServerPathAsUTF16Hex(t *testing.T) {
	resetTrustCertProbe(t)
	withMkdirAllRecorder(t)
	withRecordingIcacls(t, &recordingRunner{})
	r := &recordingRunner{responses: []fakeResponse{{out: []byte(serverPathOutput(`D:\Données\Sauvegarde`))}}}
	withRecordingRunner(t, r)
	dir, err := resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
	if err != nil {
		t.Fatal(err)
	}
	if dir != `D:\Données\Sauvegarde\breeze` {
		t.Fatalf("dir = %q", dir)
	}
	if !strings.Contains(r.calls[0], "CONVERT(varchar(4096), CAST(CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(1024)) AS varbinary(2048)), 2)") {
		t.Fatalf("query = %q", r.calls[0])
	}

	// A NULL property is not a directory: fall back to ProgramData.
	r2 := &recordingRunner{responses: []fakeResponse{{out: []byte("NULL\n\n(1 rows affected)\n")}}}
	withRecordingRunner(t, r2)
	dir, err = resolveBackupTargetDir("SQLEXPRESS", `.\SQLEXPRESS`)
	if err != nil {
		t.Fatal(err)
	}
	if want := winJoin(programDataDir(), "Breeze", "mssql-staging", "SQLEXPRESS"); dir != want {
		t.Fatalf("dir = %q, want %q", dir, want)
	}
}

// Only an unknown-option report naming -C turns -C off for the process; a
// report about any other option leaves -C on and is not retried.
func TestTrustCertFallbackIgnoresOtherUnknownOptions(t *testing.T) {
	resetTrustCertProbe(t)
	r := &recordingRunner{responses: []fakeResponse{
		{out: []byte("Sqlcmd: '-x': Unknown Option. Enter '-?' for help."), err: fmt.Errorf("exit status 1")},
		{out: []byte("1\n")},
	}}
	withRecordingRunner(t, r)
	if _, err := runSqlcmd(".", "SELECT 1"); err == nil {
		t.Fatal("expected the unknown-option failure to be returned")
	}
	if len(r.calls) != 1 {
		t.Fatalf("retried without -C: %v", r.calls)
	}
	if _, err := runSqlcmd(".", "SELECT 1"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.calls[1], " -C ") {
		t.Fatalf("-C was dropped: %q", r.calls[1])
	}
}

func TestDecodeUTF16LEHex(t *testing.T) {
	for _, want := range []string{`C:\Backups`, `D:\Données\Журнал\日本語`, "D:\\\U0001F600\\x", ""} {
		got, err := decodeUTF16LEHex(utf16Hex(want))
		if err != nil || got != want {
			t.Fatalf("decode(%q) = %q, %v", want, got, err)
		}
	}
	if got, err := decodeUTF16LEHex("0x4100"); err != nil || got != "A" {
		t.Fatalf("0x prefix: %q %v", got, err)
	}
	for _, bad := range []string{"410", "41", "ZZ00", "3DD8", "00DE4100", "3DD84100", "NULL"} {
		if got, err := decodeUTF16LEHex(bad); err == nil {
			t.Fatalf("accepted %q as %q", bad, got)
		}
	}
}

func TestBuildHeaderOnlyQueryBindsBackupFile(t *testing.T) {
	p := `C:\Backups\o'brien\TestDB_full_20260101_000000.bak`
	query, err := buildHeaderOnlyQuery(p)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(query, " RESTORE HEADERONLY FROM DISK=@backup_file") || strings.Contains(query, "brien") {
		t.Fatalf("query = %q", query)
	}
	if boundValues(t, query)["@backup_file"] != p {
		t.Fatalf("query = %q", query)
	}
	if _, err := buildHeaderOnlyQuery("C:\\a\n.bak"); err == nil {
		t.Fatal("accepted a control character")
	}
}

func TestBuildBackupQueryRefusesUnusableInput(t *testing.T) {
	if _, err := buildBackupQuery("TestDB", "C:\\a\r.bak", "full", false); err == nil {
		t.Fatal("accepted a control character in the target file")
	}
	if _, err := buildBackupQuery("TestDB", `C:\a.bak`, "snapshot", false); err == nil {
		t.Fatal("accepted an unknown backup type")
	}
}

func TestValidateInstanceName(t *testing.T) {
	for _, ok := range []string{"MSSQLSERVER", "SQLEXPRESS", "SQL$EXPRESS", "INST#2", "_inst", "Données", "legacy-name", "legacy.name"} {
		if err := validateInstanceName(ok); err != nil {
			t.Fatalf("refused %q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", ".", "..", "../x", `a\b`, "a/b", "a:b", "a'b", "a;b", "a,b", "a&b", "a@b", "a\nb", "a\x00b", "a]b"} {
		if err := validateInstanceName(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestLooksLikeTrustCertUnsupported(t *testing.T) {
	cases := map[string]bool{
		"Sqlcmd: Unknown Option '-C'.\nUsage: Sqlcmd [-S server]":     true,
		"Sqlcmd: '-C': Unknown Option. Enter '-?' for help.":          true,
		"Usage: Sqlcmd            [-U login id]  [-c cmdend]":         true,
		"Sqlcmd: '-X1': Unknown Option. Enter '-?' for help.":         false,
		"Sqlcmd: '-x': Unknown Option.\nUsage: Sqlcmd [-C trust]":     false,
		"Sqlcmd: '-c': Unknown Option.":                               false,
		"Sqlcmd: Error: Microsoft ODBC Driver 18 : SSL Provider: ...": false,
	}
	for out, want := range cases {
		if got := looksLikeTrustCertUnsupported(out); got != want {
			t.Errorf("%q: got %v, want %v", out, got, want)
		}
	}
}
