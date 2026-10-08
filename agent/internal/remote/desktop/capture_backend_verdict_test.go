//go:build unix

package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testFingerprint() sckFingerprint {
	return sckFingerprint{
		HelperPath:               "/usr/local/bin/breeze-desktop-helper",
		HelperSize:               1234,
		HelperModTime:            42,
		OSBuild:                  "24A335",
		ScreenRecordingPreflight: true,
	}
}

func newTestVerdictStore(t *testing.T) *sckVerdictStore {
	t.Helper()
	return &sckVerdictStore{dir: filepath.Join(t.TempDir(), "Breeze"), uid: os.Getuid()}
}

func TestSCKVerdictStore_AbsentIsNotAnError(t *testing.T) {
	s := newTestVerdictStore(t)
	v, err := s.load()
	if err != nil || v != nil {
		t.Fatalf("load() = %+v, %v; want nil, nil for a host with no verdict", v, err)
	}
}

// The verdict survives a helper restart: a fresh store over the same
// directory reads back what the previous process wrote (#8058).
func TestSCKVerdictStore_RoundTripAcrossInstances(t *testing.T) {
	s := newTestVerdictStore(t)
	recorded := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	want := newSCKVerdict(sckVerdictReasonDeclined, "user declined (SCStreamError -3801)", recorded, testFingerprint())
	if err := s.save(want); err != nil {
		t.Fatalf("save: %v", err)
	}

	again := &sckVerdictStore{dir: s.dir, uid: s.uid}
	got, err := again.load()
	if err != nil || got == nil {
		t.Fatalf("load() = %+v, %v", got, err)
	}
	if got.Reason != sckVerdictReasonDeclined || !got.RecordedAt.Equal(recorded) || got.Fingerprint != testFingerprint() {
		t.Fatalf("round trip lost data: %+v", got)
	}
	if reason := got.staleReason(testFingerprint()); reason != "" {
		t.Fatalf("an unchanged host reported the verdict stale: %q", reason)
	}
}

func TestSCKVerdictStore_FilesAreOwnerOnly(t *testing.T) {
	s := newTestVerdictStore(t)
	if err := s.save(newSCKVerdict(sckVerdictReasonCaptureFailed, "", time.Now(), testFingerprint())); err != nil {
		t.Fatalf("save: %v", err)
	}
	dirInfo, err := os.Stat(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("verdict dir mode = %o, want 700", perm)
	}
	fileInfo, err := os.Stat(s.path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := fileInfo.Mode().Perm(); perm != 0o600 {
		t.Fatalf("verdict file mode = %o, want 600", perm)
	}
	entries, _ := os.ReadDir(s.dir)
	if len(entries) != 1 {
		t.Fatalf("dir holds %d entries after save, want 1 (no leftover temp file)", len(entries))
	}
}

// "Until permissions change": a new helper binary, a macOS update, or a flip
// of the Screen Recording preflight each retire the verdict.
func TestSCKVerdict_StaleWhenHostChanges(t *testing.T) {
	v := newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), testFingerprint())
	cases := map[string]func(*sckFingerprint){
		"helper path":      func(f *sckFingerprint) { f.HelperPath = "/Library/Breeze/bin/breeze-desktop-helper" },
		"helper size":      func(f *sckFingerprint) { f.HelperSize++ },
		"helper mtime":     func(f *sckFingerprint) { f.HelperModTime++ },
		"macOS build":      func(f *sckFingerprint) { f.OSBuild = "24B83" },
		"preflight change": func(f *sckFingerprint) { f.ScreenRecordingPreflight = false },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			cur := testFingerprint()
			mutate(&cur)
			if v.staleReason(cur) == "" {
				t.Fatalf("verdict still applies after a %s change", name)
			}
		})
	}
}

// An operator pin is an explicit decision: it holds across upgrades and
// permission changes until the operator resets it.
func TestSCKVerdict_OperatorPinNeverGoesStale(t *testing.T) {
	v := newSCKVerdict(sckVerdictReasonOperator, "", time.Now(), testFingerprint())
	cur := testFingerprint()
	cur.HelperSize++
	cur.OSBuild = "25A1"
	cur.ScreenRecordingPreflight = false
	if reason := v.staleReason(cur); reason != "" {
		t.Fatalf("operator pin reported stale: %q", reason)
	}
}

func TestSCKVerdictStore_ClearRemovesTheVerdict(t *testing.T) {
	s := newTestVerdictStore(t)
	if removed, err := s.clear(); err != nil || removed {
		t.Fatalf("clear() on an empty store = %v, %v; want false, nil", removed, err)
	}
	if err := s.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), testFingerprint())); err != nil {
		t.Fatal(err)
	}
	if removed, err := s.clear(); err != nil || !removed {
		t.Fatalf("clear() = %v, %v; want true, nil", removed, err)
	}
	if v, err := s.load(); err != nil || v != nil {
		t.Fatalf("load() after clear = %+v, %v", v, err)
	}
}

// A symlink in place of the verdict file is refused, never followed: the
// verdict changes which capture API a process uses, so it must be a file
// this user wrote, not a pointer somewhere else.
func TestSCKVerdictStore_RefusesSymlinkedFile(t *testing.T) {
	s := newTestVerdictStore(t)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	if err := os.WriteFile(target, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, s.path()); err != nil {
		t.Fatal(err)
	}
	if _, err := s.load(); err == nil {
		t.Fatal("load() followed a symlinked verdict file")
	}
}

func TestSCKVerdictStore_RefusesSymlinkedDirectory(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.MkdirAll(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "Breeze")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	s := &sckVerdictStore{dir: link, uid: os.Getuid()}
	if err := s.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), testFingerprint())); err == nil {
		t.Fatal("save() wrote through a symlinked directory")
	}
	if _, err := s.load(); err == nil {
		t.Fatal("load() read through a symlinked directory")
	}
}

func TestSCKVerdictStore_RefusesWritableByOthers(t *testing.T) {
	t.Run("file", func(t *testing.T) {
		s := newTestVerdictStore(t)
		if err := s.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), testFingerprint())); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(s.path(), 0o666); err != nil {
			t.Fatal(err)
		}
		if _, err := s.load(); err == nil {
			t.Fatal("load() accepted a world-writable verdict file")
		}
	})
	t.Run("directory", func(t *testing.T) {
		s := newTestVerdictStore(t)
		if err := os.MkdirAll(s.dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(s.dir, 0o777); err != nil {
			t.Fatal(err)
		}
		if err := s.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), testFingerprint())); err == nil {
			t.Fatal("save() wrote into a world-writable directory")
		}
	})
}

// A verdict owned by another account is not this user's decision.
func TestSCKVerdictStore_RefusesForeignOwner(t *testing.T) {
	s := newTestVerdictStore(t)
	if err := s.save(newSCKVerdict(sckVerdictReasonDeclined, "", time.Now(), testFingerprint())); err != nil {
		t.Fatal(err)
	}
	other := &sckVerdictStore{dir: s.dir, uid: os.Getuid() + 1}
	_, err := other.load()
	if err == nil || !strings.Contains(err.Error(), "owned by uid") {
		t.Fatalf("load() as a different uid = %v, want an ownership refusal", err)
	}
}

func TestSCKVerdictStore_RejectsUnrecognisedContent(t *testing.T) {
	for name, body := range map[string]string{
		"not json":       `garbage`,
		"future schema":  `{"schema":99,"backend":"coregraphics","reason":"declined"}`,
		"unknown reason": `{"schema":1,"backend":"coregraphics","reason":"whatever"}`,
		"other backend":  `{"schema":1,"backend":"screencapturekit","reason":"declined"}`,
	} {
		t.Run(name, func(t *testing.T) {
			s := newTestVerdictStore(t)
			if err := os.MkdirAll(s.dir, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(s.path(), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if v, err := s.load(); err == nil {
				t.Fatalf("load() accepted %s: %+v", name, v)
			}
		})
	}
}

func TestSCKVerdictStore_RejectsOversizedFile(t *testing.T) {
	s := newTestVerdictStore(t)
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		t.Fatal(err)
	}
	big := `{"schema":1,"backend":"coregraphics","reason":"declined","detail":"` + strings.Repeat("x", sckVerdictMaxBytes) + `"}`
	if err := os.WriteFile(s.path(), []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.load(); err == nil {
		t.Fatal("load() accepted an oversized verdict file")
	}
}

func TestNewSCKVerdict_TruncatesDetail(t *testing.T) {
	v := newSCKVerdict(sckVerdictReasonCaptureFailed, strings.Repeat("e", 4096), time.Now(), testFingerprint())
	if len(v.Detail) > sckVerdictMaxDetail {
		t.Fatalf("detail length %d exceeds %d", len(v.Detail), sckVerdictMaxDetail)
	}
}
