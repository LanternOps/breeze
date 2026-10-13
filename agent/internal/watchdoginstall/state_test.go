package watchdoginstall

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var fixedTime = time.Date(2026, 10, 12, 12, 0, 0, 0, time.UTC)

func fixedNow() time.Time { return fixedTime }

func TestStore_MissingFileIsFreshRecord(t *testing.T) {
	s := Store{Dir: t.TempDir(), Now: fixedNow}
	rec, corrupt, err := s.Load()
	if err != nil || corrupt {
		t.Fatalf("corrupt=%v err=%v", corrupt, err)
	}
	if rec != (Record{}) {
		t.Fatalf("want zero record, got %+v", rec)
	}
}

func TestStore_CorruptFailsClosed(t *testing.T) {
	cases := map[string]string{
		"torn":            `{"v":1,"attempts":`,
		"empty":           ``,
		"not json":        `garbage`,
		"negative":        `{"v":1,"attempts":-1}`,
		"bad class":       `{"v":1,"attempts":1,"lastClass":"https://x"}`,
		"huge attempts":   `{"v":1,"attempts":100000}`,
		"wrong top type":  `[1,2,3]`,
		"unknown version": `{"v":99,"attempts":1}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, StateFileName), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			s := Store{Dir: dir, Now: fixedNow}
			rec, corrupt, err := s.Load()
			if err != nil || !corrupt {
				t.Fatalf("corrupt=%v err=%v", corrupt, err)
			}
			if rec.NextAttemptAt.IsZero() || !rec.NextAttemptAt.After(fixedNow()) {
				t.Fatal("corrupt state must defer to the slow cadence, not retry now")
			}
			if got := rec.NextAttemptAt.Sub(fixedNow()); got != CorruptStateDefer {
				t.Fatalf("defer=%v want %v", got, CorruptStateDefer)
			}
			// A corrupt record must not be re-armed by the version rule either.
			if DefaultPlan.Due(rec, "9.9.9", fixedNow()) {
				t.Fatal("corrupt state must not be due immediately for any version")
			}
		})
	}
}

func TestStore_UnknownSchemaVersionIsCorrupt(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, StateFileName), []byte(`{"v":99}`), 0o600)
	_, corrupt, err := Store{Dir: dir, Now: fixedNow}.Load()
	if err != nil || !corrupt {
		t.Fatalf("corrupt=%v err=%v", corrupt, err)
	}
}

func TestStore_RoundTrip(t *testing.T) {
	s := Store{Dir: t.TempDir(), Now: fixedNow}
	in := Record{
		SchemaVersion: SchemaVersion, BudgetVersion: "1.2.3", Attempts: 3,
		FirstAttemptAt: fixedTime, LastAttemptAt: fixedTime.Add(time.Hour),
		NextAttemptAt: fixedTime.Add(2 * time.Hour), LastClass: ClassNetwork,
	}
	if err := s.Save(in); err != nil {
		t.Fatal(err)
	}
	out, corrupt, err := s.Load()
	if err != nil || corrupt {
		t.Fatalf("corrupt=%v err=%v", corrupt, err)
	}
	if !out.LastAttemptAt.Equal(in.LastAttemptAt) || out.Attempts != 3 || out.LastClass != ClassNetwork || out.BudgetVersion != "1.2.3" {
		t.Fatalf("round trip mismatch: %+v", out)
	}
}

func TestStore_AtomicWrite(t *testing.T) {
	dir := t.TempDir()
	s := Store{Dir: dir, Now: fixedNow}
	for i := 1; i <= 2; i++ {
		if err := s.Save(Record{SchemaVersion: SchemaVersion, Attempts: i}); err != nil {
			t.Fatal(err)
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") || strings.Contains(e.Name(), ".new") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(filepath.Join(dir, StateFileName))
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("mode=%v want 0600", fi.Mode().Perm())
		}
	}
	rec, _, _ := s.Load()
	if rec.Attempts != 2 {
		t.Fatalf("attempts=%d", rec.Attempts)
	}
}

func TestStore_ResetKeepsOptOut(t *testing.T) {
	dir := t.TempDir()
	s := Store{Dir: dir, Now: fixedNow}
	if err := s.SetOptedOut(true); err != nil {
		t.Fatal(err)
	}
	if err := s.Save(Record{SchemaVersion: SchemaVersion, Attempts: 4}); err != nil {
		t.Fatal(err)
	}
	if err := s.Reset(); err != nil {
		t.Fatal(err)
	}
	if !s.OptedOut() {
		t.Fatal("Reset must never clear the opt-out marker")
	}
	if _, err := os.Stat(filepath.Join(dir, StateFileName)); !os.IsNotExist(err) {
		t.Fatalf("state should be gone, stat err=%v", err)
	}
	if err := s.Reset(); err != nil {
		t.Fatalf("Reset on missing state should be a no-op: %v", err)
	}
}

// The opt-out marker survives everything that only touches the disposable
// state file: corruption of the state, and a rewrite of the state.
func TestOptOutMarker_SurvivesStateCorruptionAndRewrite(t *testing.T) {
	dir := t.TempDir()
	s := Store{Dir: dir, Now: fixedNow}
	if err := s.SetOptedOut(true); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, StateFileName), []byte("{torn"), 0o600)
	if _, corrupt, _ := s.Load(); !corrupt {
		t.Fatal("expected corrupt")
	}
	if !s.OptedOut() {
		t.Fatal("opt-out lost after state corruption")
	}
	_ = s.Save(Record{SchemaVersion: SchemaVersion})
	if !s.OptedOut() {
		t.Fatal("opt-out lost after state rewrite")
	}
	// A fresh Store value (new process / upgraded agent) still sees it.
	if !(Store{Dir: dir}).OptedOut() {
		t.Fatal("opt-out not visible to a new Store")
	}
}

func TestOptOutMarker_SetAndClear(t *testing.T) {
	s := Store{Dir: t.TempDir(), Now: fixedNow}
	if s.OptedOut() {
		t.Fatal("fresh dir must not be opted out")
	}
	if err := s.SetOptedOut(true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetOptedOut(true); err != nil {
		t.Fatalf("idempotent set: %v", err)
	}
	if !s.OptedOut() {
		t.Fatal("want opted out")
	}
	if err := s.SetOptedOut(false); err != nil {
		t.Fatal(err)
	}
	if err := s.SetOptedOut(false); err != nil {
		t.Fatalf("idempotent clear: %v", err)
	}
	if s.OptedOut() {
		t.Fatal("want not opted out")
	}
}

// Anything other than "definitely absent" counts as opted out: an ambiguous
// state must never trigger a privileged install.
func TestOptOutMarker_UnreadableMeansOptedOut(t *testing.T) {
	dir := t.TempDir()
	// A path whose parent is a regular file → stat fails with ENOTDIR, not
	// ENOENT.
	parent := filepath.Join(dir, "file")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := Store{Dir: parent, Now: fixedNow}
	if runtime.GOOS == "windows" {
		t.Skip("ENOTDIR semantics differ on Windows")
	}
	if !s.OptedOut() {
		t.Fatal("unreadable marker must read as opted out")
	}
	if optedOut, err := s.OptOutState(); !optedOut || err == nil {
		t.Fatalf("OptOutState must fail closed AND surface the cause: optedOut=%v err=%v", optedOut, err)
	}
	if optedOut, err := (Store{Dir: dir}).OptOutState(); optedOut || err != nil {
		t.Fatalf("absent marker: optedOut=%v err=%v", optedOut, err)
	}
}

func TestStore_EmptyDirIsRejected(t *testing.T) {
	s := Store{}
	if _, _, err := s.Load(); err == nil {
		t.Fatal("Load with empty Dir must error, never default to a real path")
	}
	if err := s.Save(Record{}); err == nil {
		t.Fatal("Save with empty Dir must error")
	}
	if !s.OptedOut() {
		t.Fatal("OptedOut with empty Dir must fail safe (true)")
	}
}
