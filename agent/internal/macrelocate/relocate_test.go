package macrelocate

import (
	"bytes"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	testLegacyDir  = "/usr/local/bin"
	testTrustedDir = "/Library/Breeze/bin"
	testPlist      = "/Library/LaunchDaemons/com.breeze.agent.plist"
	testRecordDir  = "/Library/Application Support/Breeze"
)

func plistNaming(path string) []byte {
	return []byte("<array>\n        <string>" + path + "</string>\n        <string>run</string>\n    </array>")
}

type fakeInfo struct {
	name string
	mode os.FileMode
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64        { return 0 }
func (f fakeInfo) Mode() os.FileMode  { return f.mode }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeInfo) Sys() any           { return nil }

// harness records every side effect Run attempts, and fails the test on any
// the scenario says must not happen.
type harness struct {
	t *testing.T

	euid          int
	self          string
	verifyErr     error
	migrateErr    error
	migrateErrFor map[string]error
	plist         []byte
	plistErr      error
	files         map[string]fakeInfo // present paths (Lstat)
	removeErr     error
	writeRecErr   error
	allowMigrate  bool

	migrated  []string
	scripts   []string
	removed   []string
	records   []Record
	logBuffer bytes.Buffer
}

func newHarness(t *testing.T, self string) *harness {
	return &harness{t: t, euid: 0, self: self, files: map[string]fakeInfo{}, allowMigrate: true}
}

func (h *harness) cfg() Config {
	return Config{
		LegacyDir:  testLegacyDir,
		TrustedDir: testTrustedDir,
		PlistPath:  testPlist,
		Siblings:   []string{"breeze-backup"},
		RecordDir:  testRecordDir,
	}
}

func (h *harness) deps() Deps {
	return Deps{
		Geteuid:    func() int { return h.euid },
		Executable: func() (string, error) { return h.self, nil },
		VerifyLocation: func(path string) error {
			if path != h.self {
				h.t.Fatalf("VerifyLocation(%q), want the running executable %q", path, h.self)
			}
			return h.verifyErr
		},
		Migrate: func(legacyPath, trustedDir string) (string, error) {
			if !h.allowMigrate {
				h.t.Fatalf("Migrate(%q) must not be called in this scenario", legacyPath)
			}
			h.migrated = append(h.migrated, legacyPath+"->"+trustedDir)
			if h.migrateErr != nil {
				return "", h.migrateErr
			}
			if err := h.migrateErrFor[legacyPath]; err != nil {
				return "", err
			}
			return trustedDir + "/" + baseName(legacyPath), nil
		},
		StartDetached: func(script string) error {
			h.scripts = append(h.scripts, script)
			return nil
		},
		ReadFile: func(path string) ([]byte, error) {
			if path != testPlist {
				h.t.Fatalf("ReadFile(%q), want the plist", path)
			}
			return h.plist, h.plistErr
		},
		Lstat: func(path string) (os.FileInfo, error) {
			if info, ok := h.files[path]; ok {
				return info, nil
			}
			return nil, &fs.PathError{Op: "lstat", Path: path, Err: fs.ErrNotExist}
		},
		RemoveLegacyFile: func(dir, name string) error {
			if h.removeErr != nil {
				return h.removeErr
			}
			h.removed = append(h.removed, dir+"/"+name)
			delete(h.files, dir+"/"+name)
			return nil
		},
		WriteRecord: func(dir string, r Record) error {
			if dir != testRecordDir {
				h.t.Fatalf("WriteRecord dir = %q", dir)
			}
			if h.writeRecErr != nil {
				return h.writeRecErr
			}
			h.records = append(h.records, r)
			return nil
		},
		Now: func() time.Time { return time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC) },
		Log: slog.New(slog.NewTextHandler(&h.logBuffer, &slog.HandlerOptions{Level: slog.LevelDebug})),
	}
}

func baseName(p string) string { return p[strings.LastIndex(p, "/")+1:] }

func regular(name string) fakeInfo { return fakeInfo{name: name, mode: 0o755} }

func TestRunSkipsWhenNotPrivileged(t *testing.T) {
	h := newHarness(t, testLegacyDir+"/breeze-agent")
	h.euid = 501
	h.allowMigrate = false
	if got := Run(h.cfg(), h.deps()); got != OutcomeUnprivileged {
		t.Fatalf("outcome = %q, want %q", got, OutcomeUnprivileged)
	}
}

// TestRunLegacyLocationDecision is the #7211 decision table as seen by the
// running daemon: a safe /usr/local/bin keeps the binary (and its path-keyed
// Full Disk Access grant) where it is; anything the ownership check rejects
// or cannot verify still relocates, because that is the security reason the
// move exists (#7199).
func TestRunLegacyLocationDecision(t *testing.T) {
	cases := []struct {
		name        string
		verifyErr   error
		wantOutcome Outcome
	}{
		{"root-owned 0755 chain stays put", nil, OutcomeKeptLegacy},
		{"user-owned dir relocates", errors.New("directory /usr/local/bin: not owned by root (uid 501)"), OutcomeRelocationScheduled},
		{"group-writable dir relocates", errors.New("directory /usr/local/bin: group- or world-writable (mode 775)"), OutcomeRelocationScheduled},
		{"unverifiable (missing) dir relocates", &fs.PathError{Op: "lstat", Path: "/usr/local/bin", Err: fs.ErrNotExist}, OutcomeRelocationScheduled},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, testLegacyDir+"/breeze-agent")
			h.verifyErr = tc.verifyErr
			h.allowMigrate = tc.wantOutcome != OutcomeKeptLegacy
			got := Run(h.cfg(), h.deps())
			if got != tc.wantOutcome {
				t.Fatalf("outcome = %q, want %q", got, tc.wantOutcome)
			}
			if tc.wantOutcome == OutcomeKeptLegacy {
				if len(h.scripts) != 0 || len(h.removed) != 0 || len(h.records) != 0 {
					t.Fatalf("safe legacy install must be left untouched; scripts=%v removed=%v records=%v", h.scripts, h.removed, h.records)
				}
				return
			}
			if len(h.migrated) != 1 || h.migrated[0] != "/usr/local/bin/breeze-agent->/Library/Breeze/bin" {
				t.Fatalf("migrated = %v", h.migrated)
			}
			if len(h.scripts) != 1 {
				t.Fatalf("want one relocation script, got %d", len(h.scripts))
			}
			logs := h.logBuffer.String()
			if !strings.Contains(logs, "level=WARN") || !strings.Contains(logs, "Full Disk Access") {
				t.Fatalf("relocation must warn that Full Disk Access needs re-granting; logs:\n%s", logs)
			}
			if !strings.Contains(logs, tc.verifyErr.Error()) {
				t.Fatalf("relocation warning must carry the reason %q; logs:\n%s", tc.verifyErr, logs)
			}
		})
	}
}

func TestRunRelocationSchedulesScriptForThisBinary(t *testing.T) {
	h := newHarness(t, testLegacyDir+"/breeze-agent")
	h.verifyErr = errors.New("not owned by root")
	Run(h.cfg(), h.deps())
	if want := BuildRelocateScript(testPlist, testLegacyDir+"/breeze-agent", testTrustedDir+"/breeze-agent"); h.scripts[0] != want {
		t.Fatalf("script = %q, want %q", h.scripts[0], want)
	}
}

// The agent resolves breeze-backup next to its own executable, so a
// relocation that moved only the agent would break every backup until the
// next .pkg install. Siblings present in the legacy dir move with it.
func TestRunRelocationCopiesSiblings(t *testing.T) {
	h := newHarness(t, testLegacyDir+"/breeze-agent")
	h.verifyErr = errors.New("not owned by root")
	h.files[testLegacyDir+"/breeze-backup"] = regular("breeze-backup")
	if got := Run(h.cfg(), h.deps()); got != OutcomeRelocationScheduled {
		t.Fatalf("outcome = %q", got)
	}
	want := "/usr/local/bin/breeze-backup->/Library/Breeze/bin,/usr/local/bin/breeze-agent->/Library/Breeze/bin"
	if got := strings.Join(h.migrated, ","); got != want {
		t.Fatalf("migrated = %s, want %s", got, want)
	}
}

// A sibling that cannot be copied aborts the relocation (retried on the
// next start) rather than leaving a half-moved install.
func TestRunRelocationSiblingCopyFailureAborts(t *testing.T) {
	h := newHarness(t, testLegacyDir+"/breeze-agent")
	h.verifyErr = errors.New("not owned by root")
	h.files[testLegacyDir+"/breeze-backup"] = regular("breeze-backup")
	h.migrateErrFor = map[string]error{testLegacyDir + "/breeze-backup": errors.New("disk full")}
	if got := Run(h.cfg(), h.deps()); got != OutcomeRelocationFailed {
		t.Fatalf("outcome = %q, want %q", got, OutcomeRelocationFailed)
	}
	if len(h.scripts) != 0 {
		t.Fatal("a failed sibling copy must not repoint the plist")
	}
	// The agent itself must not have been copied: its trusted copy would
	// make the next .pkg install treat this host as already relocated.
	for _, m := range h.migrated {
		if strings.HasPrefix(m, testLegacyDir+"/breeze-agent->") {
			t.Fatalf("agent copied despite the sibling failure: %v", h.migrated)
		}
	}
}

// A missing (or symlinked) sibling is not copied and does not block the move.
func TestRunRelocationSkipsAbsentSibling(t *testing.T) {
	h := newHarness(t, testLegacyDir+"/breeze-agent")
	h.verifyErr = errors.New("not owned by root")
	h.files[testLegacyDir+"/breeze-backup"] = fakeInfo{name: "breeze-backup", mode: os.ModeSymlink | 0o755}
	if got := Run(h.cfg(), h.deps()); got != OutcomeRelocationScheduled {
		t.Fatalf("outcome = %q", got)
	}
	if len(h.migrated) != 1 {
		t.Fatalf("migrated = %v, want only the agent", h.migrated)
	}
}

func TestRunRelocationCopyFailureNeverSchedulesReload(t *testing.T) {
	h := newHarness(t, testLegacyDir+"/breeze-agent")
	h.verifyErr = errors.New("not owned by root")
	h.migrateErr = errors.New("disk full")
	if got := Run(h.cfg(), h.deps()); got != OutcomeRelocationFailed {
		t.Fatalf("outcome = %q, want %q", got, OutcomeRelocationFailed)
	}
	if len(h.scripts) != 0 {
		t.Fatal("a failed copy must not repoint the plist")
	}
}

// TestRunFromTrustedNeverRelocatesAgain covers the pkg-reinstall shape: once
// the install lives in the trusted directory (moved there by an earlier
// agent, or installed there by the .pkg because it found it already there),
// a restart never copies or reloads again.
func TestRunFromTrustedNeverRelocatesAgain(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	if got := Run(h.cfg(), h.deps()); got != OutcomeTrusted {
		t.Fatalf("outcome = %q, want %q", got, OutcomeTrusted)
	}
	if len(h.scripts) != 0 {
		t.Fatal("running from the trusted dir must never schedule a reload")
	}
}

func TestRunFromTrustedRemovesLeftoverLegacyCopyAndRecordsRelocation(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	h.files[testLegacyDir+"/breeze-agent"] = regular("breeze-agent")
	h.files[testLegacyDir+"/breeze-backup"] = regular("breeze-backup")
	h.files[testTrustedDir+"/breeze-backup"] = regular("breeze-backup")

	Run(h.cfg(), h.deps())

	want := []string{testLegacyDir + "/breeze-agent", testLegacyDir + "/breeze-backup"}
	if strings.Join(h.removed, ",") != strings.Join(want, ",") {
		t.Fatalf("removed = %v, want %v", h.removed, want)
	}
	if len(h.records) != 1 {
		t.Fatalf("want one relocation record, got %d", len(h.records))
	}
	r := h.records[0]
	if r.From != testLegacyDir+"/breeze-agent" || r.To != testTrustedDir+"/breeze-agent" || r.RecordedAt.IsZero() {
		t.Fatalf("record = %+v", r)
	}
}

// The record must be written before the leftover is removed: if the order
// were reversed, a failed record write would leave no trace that this
// binary lost its Full Disk Access grant, and there would be nothing left to
// detect it from on the next start.
func TestRunKeepsLeftoverWhenRecordCannotBeWritten(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	h.files[testLegacyDir+"/breeze-agent"] = regular("breeze-agent")
	h.writeRecErr = errors.New("read-only")

	Run(h.cfg(), h.deps())

	if len(h.removed) != 0 {
		t.Fatalf("leftover removed despite the record write failing: %v", h.removed)
	}
}

// The next start retries: once the record can be written, the leftover goes.
func TestRunRetriesCleanupAfterRecordWriteFailure(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	h.files[testLegacyDir+"/breeze-agent"] = regular("breeze-agent")
	h.writeRecErr = errors.New("read-only")
	Run(h.cfg(), h.deps())
	if len(h.removed) != 0 || len(h.records) != 0 {
		t.Fatalf("first start: removed=%v records=%v", h.removed, h.records)
	}

	h.writeRecErr = nil
	Run(h.cfg(), h.deps())
	if len(h.records) != 1 || len(h.removed) != 1 {
		t.Fatalf("second start: records=%v removed=%v, want one of each", h.records, h.removed)
	}

	// Third start: nothing left to do, nothing re-recorded.
	Run(h.cfg(), h.deps())
	if len(h.records) != 1 || len(h.removed) != 1 {
		t.Fatalf("third start: records=%v removed=%v", h.records, h.removed)
	}
}

func TestRunKeepsLegacyCopyWhilePlistStillNamesIt(t *testing.T) {
	cases := map[string][]byte{
		"plist names legacy path": plistNaming(testLegacyDir + "/breeze-agent"),
		"plist names both":        append(plistNaming(testLegacyDir+"/breeze-agent"), plistNaming(testTrustedDir+"/breeze-agent")...),
		"plist names neither":     plistNaming("/opt/elsewhere/breeze-agent"),
	}
	for name, plist := range cases {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t, testTrustedDir+"/breeze-agent")
			h.allowMigrate = false
			h.plist = plist
			h.files[testLegacyDir+"/breeze-agent"] = regular("breeze-agent")
			Run(h.cfg(), h.deps())
			if len(h.removed) != 0 || len(h.records) != 0 {
				t.Fatalf("must not touch the legacy copy; removed=%v records=%v", h.removed, h.records)
			}
		})
	}
}

func TestRunKeepsLegacyCopyWhenPlistUnreadable(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plistErr = fs.ErrPermission
	h.files[testLegacyDir+"/breeze-agent"] = regular("breeze-agent")
	Run(h.cfg(), h.deps())
	if len(h.removed) != 0 {
		t.Fatalf("removed = %v", h.removed)
	}
}

func TestRunNoLeftoverWritesNoRecord(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	Run(h.cfg(), h.deps())
	if len(h.records) != 0 || len(h.removed) != 0 {
		t.Fatalf("records=%v removed=%v", h.records, h.removed)
	}
}

// A symlink at the legacy name is not a copy Breeze left behind; it is
// neither removed nor counted as a relocation.
func TestRunIgnoresNonRegularLegacyEntry(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	h.files[testLegacyDir+"/breeze-agent"] = fakeInfo{name: "breeze-agent", mode: os.ModeSymlink | 0o755}
	Run(h.cfg(), h.deps())
	if len(h.records) != 0 || len(h.removed) != 0 {
		t.Fatalf("records=%v removed=%v", h.records, h.removed)
	}
}

func TestRunKeepsLegacySiblingWithoutTrustedCopy(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	h.files[testLegacyDir+"/breeze-backup"] = regular("breeze-backup")
	Run(h.cfg(), h.deps())
	if len(h.removed) != 0 {
		t.Fatalf("legacy sibling removed with no trusted replacement: %v", h.removed)
	}
}

func TestRunWithoutRecordDirStillCleansUp(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-watchdog")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-watchdog")
	h.files[testLegacyDir+"/breeze-watchdog"] = regular("breeze-watchdog")
	cfg := h.cfg()
	cfg.RecordDir = ""
	cfg.Siblings = nil
	Run(cfg, h.deps())
	if len(h.records) != 0 {
		t.Fatalf("records = %v, want none without a RecordDir", h.records)
	}
	if len(h.removed) != 1 || h.removed[0] != testLegacyDir+"/breeze-watchdog" {
		t.Fatalf("removed = %v", h.removed)
	}
}

func TestRunRemovalFailureIsLoggedNotFatal(t *testing.T) {
	h := newHarness(t, testTrustedDir+"/breeze-agent")
	h.allowMigrate = false
	h.plist = plistNaming(testTrustedDir + "/breeze-agent")
	h.files[testLegacyDir+"/breeze-agent"] = regular("breeze-agent")
	h.removeErr = errors.New("operation not permitted")
	if got := Run(h.cfg(), h.deps()); got != OutcomeTrusted {
		t.Fatalf("outcome = %q", got)
	}
	if !strings.Contains(h.logBuffer.String(), "operation not permitted") {
		t.Fatalf("removal failure not logged:\n%s", h.logBuffer.String())
	}
}

func TestRunOtherLocationIsNoOp(t *testing.T) {
	h := newHarness(t, "/Users/dev/go/bin/breeze-agent")
	h.allowMigrate = false
	if got := Run(h.cfg(), h.deps()); got != OutcomeOtherLocation {
		t.Fatalf("outcome = %q", got)
	}
}

func TestRunExecutableErrorIsNoOp(t *testing.T) {
	h := newHarness(t, "")
	h.allowMigrate = false
	d := h.deps()
	d.Executable = func() (string, error) { return "", errors.New("boom") }
	if got := Run(h.cfg(), d); got != OutcomeUnresolved {
		t.Fatalf("outcome = %q", got)
	}
}
