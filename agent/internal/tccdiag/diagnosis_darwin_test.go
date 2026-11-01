//go:build darwin && cgo

package tccdiag

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// These run the real Security.framework and SQLite calls against the test
// binary, which is ad-hoc (arm64 linker signature) or unsigned (amd64): no
// signed binary is needed. The csreq and sqlite3 tools only build fixtures.

const testDeveloperIDRequirement = `identifier "breeze-desktop-helper-darwin-amd64" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = D8W6N2JYMA`

// compileRequirement turns requirement text into the binary blob TCC stores
// in csreq.
func compileRequirement(t *testing.T, req string) []byte {
	t.Helper()
	if _, err := exec.LookPath("csreq"); err != nil {
		t.Skip("csreq not available")
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
	switch s.Kind {
	case SigningAdhoc:
		if !strings.HasPrefix(s.DesignatedRequirement, "cdhash H\"") || s.CDHash == "" {
			t.Fatalf("ad-hoc signing = %+v, want a cdhash designated requirement and a cdhash", s)
		}
	case SigningUnsigned:
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

// makeTCCDB builds an access table shaped like TCC.db's.
func makeTCCDB(t *testing.T, pragma string, csreq []byte) string {
	t.Helper()
	if _, err := exec.LookPath("sqlite3"); err != nil {
		t.Skip("sqlite3 not available")
	}
	path := filepath.Join(t.TempDir(), "TCC.db")
	hexBlob := "X'" + strings.ToUpper(hexString(csreq)) + "'"
	script := pragma + `
CREATE TABLE access (service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL,
  auth_value INTEGER NOT NULL, auth_reason INTEGER NOT NULL, auth_version INTEGER NOT NULL,
  csreq BLOB, policy_id INTEGER, last_modified INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  PRIMARY KEY (service, client, client_type));
INSERT INTO access VALUES ('kTCCServiceScreenCapture', '/usr/local/bin/breeze-desktop-helper', 1, 2, 2, 1, ` + hexBlob + `, NULL, 1761955200);
INSERT INTO access VALUES ('kTCCServiceAccessibility', '/usr/local/bin/breeze-desktop-helper', 1, 2, 4, 1, NULL, NULL, 1700000000);
INSERT INTO access VALUES ('kTCCServiceScreenCapture', '/usr/local/bin/other', 1, 2, 2, 1, NULL, NULL, 1);
INSERT INTO access VALUES ('kTCCServiceMicrophone', '/usr/local/bin/breeze-desktop-helper', 1, 2, 2, 1, NULL, NULL, 1);
`
	cmd := exec.Command("sqlite3", path)
	cmd.Stdin = strings.NewReader(script)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("sqlite3: %v: %s", err, b)
	}
	return path
}

func hexString(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, 0, len(b)*2)
	for _, c := range b {
		out = append(out, digits[c>>4], digits[c&0xf])
	}
	return string(out)
}

func TestSQLiteRowReader_ReadsOnlyThisClientsServices(t *testing.T) {
	for _, mode := range []struct{ name, pragma string }{
		{"rollback journal", ""},
		{"wal", "PRAGMA journal_mode=WAL;"},
	} {
		t.Run(mode.name, func(t *testing.T) {
			blob := []byte{0xfa, 0xde, 0x0c, 0x00, 0x01}
			path := makeTCCDB(t, mode.pragma, blob)
			before, _ := os.ReadFile(path)

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
			after, _ := os.ReadFile(path)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("reading the database changed it")
			}
		})
	}
}

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
