//go:build darwin && cgo

package tccdiag

import (
	"bufio"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// skipOrFail skips locally but fails in CI: these are the only tests that
// reach the real Security.framework and SQLite, so the macOS race job must
// not go green without running them.
func skipOrFail(t *testing.T, why string) {
	t.Helper()
	if os.Getenv("CI") != "" {
		t.Fatalf("would skip in CI: %s", why)
	}
	t.Skip(why)
}

// wantAdhocTestBinary reports whether the test binary carries the arm64
// linker's ad-hoc signature, which every arm64 build has.
func wantAdhocTestBinary() bool { return runtime.GOARCH == "arm64" }

// These run the real Security.framework and SQLite calls against the test
// binary, which is ad-hoc (arm64 linker signature) or unsigned (amd64): no
// signed binary is needed. The csreq and sqlite3 tools only build fixtures.

const testDeveloperIDRequirement = `identifier "breeze-desktop-helper-darwin-amd64" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = D8W6N2JYMA`

// compileRequirement turns requirement text into the binary blob TCC stores
// in csreq.
func compileRequirement(t *testing.T, req string) []byte {
	t.Helper()
	if _, err := exec.LookPath("csreq"); err != nil {
		skipOrFail(t, "csreq not available")
	}
	out := filepath.Join(t.TempDir(), "req.bin")
	if b, err := exec.Command("csreq", "-r="+req, "-b", out).CombinedOutput(); err != nil {
		t.Fatalf("csreq: %v: %s", err, b)
	}
	blob, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	return blob
}

func TestSecurityInspector_SigningOfTestBinary(t *testing.T) {
	s := securityInspector{}.Signing()
	if wantAdhocTestBinary() && s.Kind != SigningAdhoc {
		t.Fatalf("arm64 test binary signing = %+v, want adhoc (the linker signs every arm64 binary)", s)
	}
	switch s.Kind {
	case SigningAdhoc:
		if !strings.HasPrefix(s.DesignatedRequirement, "cdhash H\"") || s.CDHash == "" {
			t.Fatalf("ad-hoc signing = %+v, want a cdhash designated requirement and a cdhash", s)
		}
	case SigningUnsigned:
		if s.DesignatedRequirement != "" || s.Error != "" {
			t.Fatalf("unsigned signing = %+v, want no requirement and no error", s)
		}
	default:
		t.Fatalf("test binary signing = %+v, want adhoc or unsigned", s)
	}
	if s.TeamID != "" {
		t.Fatalf("test binary reports team %q", s.TeamID)
	}
}

// The #5953 Host B mismatch: a Developer ID csreq against ad-hoc code.
func TestSecurityInspector_DeveloperIDRequirementNotSatisfied(t *testing.T) {
	blob := compileRequirement(t, testDeveloperIDRequirement)

	req, satisfied, err := securityInspector{}.CheckRequirement(blob)

	if err != nil {
		t.Fatalf("CheckRequirement: %v", err)
	}
	if satisfied {
		t.Fatal("ad-hoc test binary satisfied the Developer ID requirement")
	}
	if !strings.Contains(req, "D8W6N2JYMA") || !strings.Contains(req, `"breeze-desktop-helper-darwin-amd64"`) {
		t.Fatalf("decoded requirement = %q", req)
	}
}

// The control: the running code's own designated requirement is satisfied,
// so a "false" above is the requirement, not a broken check.
func TestSecurityInspector_OwnDesignatedRequirementSatisfied(t *testing.T) {
	s := securityInspector{}.Signing()
	if s.Kind != SigningAdhoc {
		if wantAdhocTestBinary() {
			t.Fatalf("arm64 test binary is %s, want adhoc", s.Kind)
		}
		t.Skipf("test binary is %s; no designated requirement to check", s.Kind)
	}
	blob := compileRequirement(t, s.DesignatedRequirement)

	_, satisfied, err := securityInspector{}.CheckRequirement(blob)

	if err != nil || !satisfied {
		t.Fatalf("own designated requirement: satisfied=%t err=%v, want satisfied", satisfied, err)
	}
}

func TestSecurityInspector_GarbageBlobIsAnError(t *testing.T) {
	if _, _, err := (securityInspector{}).CheckRequirement([]byte("not a requirement")); err == nil {
		t.Fatal("a garbage csreq decoded without error")
	}
}

// tccFixtureSQL builds an access table shaped like TCC.db's.
func tccFixtureSQL(csreq []byte) string {
	hexBlob := "X'" + strings.ToUpper(hexString(csreq)) + "'"
	return `
CREATE TABLE access (service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL,
  auth_value INTEGER NOT NULL, auth_reason INTEGER NOT NULL, auth_version INTEGER NOT NULL,
  csreq BLOB, policy_id INTEGER, last_modified INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  PRIMARY KEY (service, client, client_type));
INSERT INTO access VALUES ('kTCCServiceScreenCapture', '/usr/local/bin/breeze-desktop-helper', 1, 2, 2, 1, ` + hexBlob + `, NULL, 1761955200);
INSERT INTO access VALUES ('kTCCServiceAccessibility', '/usr/local/bin/breeze-desktop-helper', 1, 2, 4, 1, NULL, NULL, 1700000000);
INSERT INTO access VALUES ('kTCCServiceScreenCapture', '/usr/local/bin/other', 1, 2, 2, 1, NULL, NULL, 1);
INSERT INTO access VALUES ('kTCCServiceMicrophone', '/usr/local/bin/breeze-desktop-helper', 1, 2, 2, 1, NULL, NULL, 1);
`
}

func needSQLite3(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("sqlite3"); err != nil {
		skipOrFail(t, "sqlite3 not available")
	}
}

// makeTCCDB writes the fixture with the sqlite3 tool, which has exited by
// the time it returns.
func makeTCCDB(t *testing.T, pragma string, csreq []byte) string {
	t.Helper()
	needSQLite3(t)
	path := filepath.Join(t.TempDir(), "TCC.db")
	cmd := exec.Command("sqlite3", path)
	cmd.Stdin = strings.NewReader(pragma + tccFixtureSQL(csreq))
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sqlite3: %v: %s", err, b)
	}
	return path
}

// makeClosedWALTCCDB is a WAL-mode database whose last connection
// checkpointed and closed. Whether the sqlite3 tool then leaves an empty -wal
// and the -shm behind differs by macOS build (the macOS 26 runner image
// removes them, macOS 27 keeps them), so the fixture removes both to pin the
// shape. A read-only SQLite connection cannot create the -wal, so opening
// this read-only in place fails with SQLITE_CANTOPEN (rc 14).
func makeClosedWALTCCDB(t *testing.T, csreq []byte) string {
	t.Helper()
	path := makeTCCDB(t, "PRAGMA journal_mode=WAL;", csreq)
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(path + suffix); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
	}
	if !isWALMode(t, path) {
		t.Fatal("fixture is not in WAL mode")
	}
	return path
}

// makeLiveWALTCCDB is the shape tccd leaves: a writer holds the database open
// in WAL mode and the newest rows exist only in the -wal. The writer stays
// open until the test ends.
func makeLiveWALTCCDB(t *testing.T, csreq []byte) string {
	t.Helper()
	needSQLite3(t)
	path := filepath.Join(t.TempDir(), "TCC.db")
	cmd := exec.Command("sqlite3", path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	})
	if _, err := io.WriteString(stdin, "PRAGMA journal_mode=WAL;\n"+tccFixtureSQL(csreq)+".print fixture-ready\n"); err != nil {
		t.Fatal(err)
	}
	lines := bufio.NewScanner(stdout)
	for lines.Scan() {
		if lines.Text() == "fixture-ready" {
			break
		}
	}
	if err := lines.Err(); err != nil {
		t.Fatal(err)
	}
	// Control: the rows must be in the -wal only, or this case is just the
	// closed one again. immutable=1 reads the main file and ignores the -wal.
	if out, err := exec.Command("sqlite3", "file:"+path+"?immutable=1", "SELECT count(*) FROM access").CombinedOutput(); err == nil {
		t.Fatalf("main database file already holds the access table (%s); the rows must live only in the -wal", strings.TrimSpace(string(out)))
	}
	return path
}

func isWALMode(t *testing.T, path string) bool {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	header := make([]byte, 20)
	if _, err := io.ReadFull(f, header); err != nil {
		t.Fatal(err)
	}
	// File format write/read versions are 2 in WAL mode.
	return header[18] == 2 && header[19] == 2
}

// dirState is every file in dir with its bytes and mode, so a test can prove
// a read neither changed nor created anything next to the database.
func dirState(t *testing.T, dir string) map[string]string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			t.Fatal(err)
		}
		out[e.Name()] = fmt.Sprintf("%s %s %x", info.Mode(), info.ModTime().Format(time.RFC3339Nano), sha256.Sum256(b))
	}
	return out
}

func hexString(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&0xf])
	}
	return string(out)
}

// The real TCC.db is in WAL mode. Each shape must read the same rows and
// leave the database directory exactly as it was: no -wal or -shm created,
// no byte changed, and no snapshot left in the temp directory.
func TestSQLiteRowReader_ReadsOnlyThisClientsServices(t *testing.T) {
	for _, shape := range []struct {
		name string
		make func(t *testing.T, csreq []byte) string
	}{
		{"rollback journal", func(t *testing.T, csreq []byte) string { return makeTCCDB(t, "", csreq) }},
		{"wal closed, no -wal or -shm", makeClosedWALTCCDB},
		{"wal held open by a writer, rows only in -wal", makeLiveWALTCCDB},
	} {
		t.Run(shape.name, func(t *testing.T) {
			tmp := t.TempDir()
			t.Setenv("TMPDIR", tmp)
			blob := []byte{0xfa, 0xde, 0x0c, 0x00, 0x01}
			path := shape.make(t, blob)
			before := dirState(t, filepath.Dir(path))

			rows, err := sqliteRowReader{}.ReadRows(path,
				[]string{"/usr/local/bin/breeze-desktop-helper"},
				[]Service{ServiceScreenCapture, ServiceAccessibility})
			if err != nil {
				t.Fatalf("ReadRows: %v", err)
			}
			byService := map[Service]Row{}
			for _, r := range rows {
				byService[r.Service] = r
			}
			if len(rows) != 2 {
				t.Fatalf("rows = %+v, want the helper's screen capture and accessibility rows only", rows)
			}
			sc := byService[ServiceScreenCapture]
			if sc.AuthValue != 2 || sc.AuthReason != 2 || !reflect.DeepEqual(sc.Csreq, blob) || sc.LastModified != 1761955200 {
				t.Fatalf("screen capture row = %+v", sc)
			}
			ax := byService[ServiceAccessibility]
			if ax.AuthReason != 4 || ax.Csreq != nil {
				t.Fatalf("accessibility row = %+v, want auth_reason 4 with NULL csreq", ax)
			}
			if after := dirState(t, filepath.Dir(path)); !reflect.DeepEqual(before, after) {
				t.Fatalf("reading the database changed its directory:\nbefore %v\nafter  %v", before, after)
			}
			if left, _ := os.ReadDir(tmp); len(left) != 0 {
				t.Fatalf("snapshot left behind in the temp directory: %v", left)
			}
		})
	}
}

// chmod 000 gives EACCES; TCC's refusal without Full Disk Access is EPERM.
// Both are os.ErrPermission, which is what ReadRows maps.
func TestSQLiteRowReader_PermissionDeniedIsNotReadable(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root ignores file modes")
	}
	path := makeTCCDB(t, "", nil)
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })

	_, err := sqliteRowReader{}.ReadRows(path, []string{"x"}, []Service{ServiceScreenCapture})

	if !errors.Is(err, ErrNotReadable) {
		t.Fatalf("err = %v, want ErrNotReadable", err)
	}
}

func TestSQLiteRowReader_MissingDatabaseIsAnError(t *testing.T) {
	_, err := sqliteRowReader{}.ReadRows(filepath.Join(t.TempDir(), "absent.db"), []string{"x"}, []Service{ServiceScreenCapture})
	if err == nil || errors.Is(err, ErrNotReadable) {
		t.Fatalf("err = %v, want a plain open error", err)
	}
}

// End to end through the real inspector and reader: an ad-hoc binary against
// a Developer ID row is a requirement mismatch, and a NULL-csreq row is the
// legacy shape.
func TestDiagnose_RealPlatformLayer(t *testing.T) {
	if (securityInspector{}).Signing().Kind != SigningAdhoc {
		if wantAdhocTestBinary() {
			t.Fatal("arm64 test binary is not ad-hoc signed")
		}
		t.Skip("needs an ad-hoc signed test binary (arm64)")
	}
	path := makeTCCDB(t, "", compileRequirement(t, testDeveloperIDRequirement))

	d := Diagnose(Env{
		Code:     securityInspector{},
		Rows:     sqliteRowReader{},
		Clients:  []string{"/usr/local/bin/breeze-desktop-helper"},
		SystemDB: path,
	}, []Service{ServiceScreenCapture, ServiceAccessibility})

	if d.Verdict != VerdictRequirementMismatch {
		t.Fatalf("verdict = %q, want requirement_mismatch: %+v", d.Verdict, d)
	}
	if d.Services[0].Verdict != VerdictRequirementMismatch || !strings.Contains(d.Services[0].StoredRequirement, "D8W6N2JYMA") {
		t.Fatalf("screen capture = %+v", d.Services[0])
	}
	if d.Services[1].Verdict != VerdictLegacyRowNoCsreq {
		t.Fatalf("accessibility = %+v, want legacy_row_no_csreq", d.Services[1])
	}
}

func TestRun_ReportsHostAndNeverPanics(t *testing.T) {
	d := Run([]Service{ServiceScreenCapture})
	if d.MacOSVersion == "" || d.MacOSBuild == "" || d.ExecutablePath == "" {
		t.Fatalf("diagnosis header = %+v", d)
	}
	if len(d.Services) != 1 || d.Verdict == "" {
		t.Fatalf("diagnosis = %+v", d)
	}
}
