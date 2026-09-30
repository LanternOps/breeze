package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

func TestParseBackupProtocols(t *testing.T) {
	cases := []struct {
		name   string
		out    string
		want   backupipc.ProtocolInfo
		wantOK bool
	}{
		{"read only (helper predates the other fields)", `{"backupReadProtocolVersion":1}` + "\n", backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}, true},
		{"all three", `{"backupReadProtocolVersion":1,"backupIntegrityProtocolVersion":2,"backupWriteProtocolVersion":1}`, backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}, true},
		{"future versions pass through", `{"backupReadProtocolVersion":3,"backupIntegrityProtocolVersion":7}`, backupipc.ProtocolInfo{BackupReadProtocolVersion: 3, BackupIntegrityProtocolVersion: 7}, true},
		{"explicit zeros", `{"backupReadProtocolVersion":0,"backupIntegrityProtocolVersion":0,"backupWriteProtocolVersion":0}`, backupipc.ProtocolInfo{}, true},
		// A known answer overrides what the server last stored (and a lower
		// one is audited as a drop), so only an object that carries the read
		// field every helper with the flag prints counts as an answer.
		{"keys absent", `{"other":1}`, backupipc.ProtocolInfo{}, false},
		{"empty object", `{}`, backupipc.ProtocolInfo{}, false},
		{"json null", "null\n", backupipc.ProtocolInfo{}, false},
		{"read field null", `{"backupReadProtocolVersion":null}`, backupipc.ProtocolInfo{}, false},
		{"array", `[1]`, backupipc.ProtocolInfo{}, false},
		{"negative integrity and write read as 0", `{"backupReadProtocolVersion":1,"backupIntegrityProtocolVersion":-1,"backupWriteProtocolVersion":-3}`, backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}, true},
		{"negative read fails the probe", `{"backupReadProtocolVersion":-1,"backupIntegrityProtocolVersion":1}`, backupipc.ProtocolInfo{}, false},
		{"not json", "Error: unknown flag: --protocol-info\n", backupipc.ProtocolInfo{}, false},
		{"wrong type", `{"backupReadProtocolVersion":"1"}`, backupipc.ProtocolInfo{}, false},
		{"empty", "", backupipc.ProtocolInfo{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseBackupProtocols(tc.out)
			if got != tc.want || ok != tc.wantOK {
				t.Fatalf("parseBackupProtocols(%q) = (%+v, %v), want (%+v, %v)", tc.out, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestBackupProtocols_ReportsAllThreeFromOneProbe(t *testing.T) {
	calls := 0
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}, backupProbeOK
	}}
	want := backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}
	if got, known := h.backupProtocols(); !known || got != want {
		t.Fatalf("protocols = (%+v, known %v), want (%+v, known)", got, known, want)
	}
	_, _ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want one probe for all three values", calls)
	}
}

func TestBackupProtocols_NegativeValuesReadAsZero(t *testing.T) {
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		return backupipc.ProtocolInfo{BackupReadProtocolVersion: -1, BackupIntegrityProtocolVersion: -2, BackupWriteProtocolVersion: -3}, backupProbeOK
	}}
	if got, known := h.backupProtocols(); !known || got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = (%+v, known %v), want a known all-0 answer", got, known)
	}
}

func TestBackupProtocols_CachesSuccessAndInvalidatesOnInstall(t *testing.T) {
	calls := 0
	info := backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return info, backupProbeOK
	}}
	if got, known := h.backupProtocols(); !known || got != info {
		t.Fatalf("protocols = (%+v, known %v), want %+v", got, known, info)
	}
	_, _ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want a cached read", calls)
	}
	// A helper update (reconcile/prefetch swap) invalidates the backup
	// version cache; every protocol must be re-read from the new binary.
	info = backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}
	h.invalidateBackupVersionCache()
	if got, known := h.backupProtocols(); !known || got != info {
		t.Fatalf("protocols after a helper swap = (%+v, known %v), want %+v", got, known, info)
	}
	if calls != 2 {
		t.Fatalf("probe calls = %d, want a re-read after install", calls)
	}
}

// A helper that answers and says it supports nothing is a real 0, cached like
// any other answer. It is never confused with a probe that got no answer.
func TestBackupProtocols_RealZeroIsKnown(t *testing.T) {
	calls := 0
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return backupipc.ProtocolInfo{}, backupProbeOK
	}}
	if got, known := h.backupProtocols(); !known || got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = (%+v, known %v), want a known all-0 answer", got, known)
	}
	_, _ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want a real 0 cached like any answer", calls)
	}
}

func TestBackupProtocols_ProbeWithoutAnAnswerIsUnknown(t *testing.T) {
	cases := []struct {
		name    string
		outcome backupProbeOutcome
	}{
		{"probe failed (timeout, crash, unparseable output)", backupProbeFailed},
		{"helper not installed yet", backupProbeNotInstalled},
		{"helper path unresolved", backupProbeUnresolved},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
				// Whatever the reader returned alongside a non-answer is ignored.
				return backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupWriteProtocolVersion: 1}, tc.outcome
			}}
			if got, known := h.backupProtocols(); known || got != (backupipc.ProtocolInfo{}) {
				t.Fatalf("protocols = (%+v, known %v), want unknown", got, known)
			}
		})
	}
}

func TestBackupProtocols_FailedProbeRetriesWithShortBackoff(t *testing.T) {
	calls := 0
	outcome := backupProbeFailed
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}, outcome
	}}
	if _, known := h.backupProtocols(); known {
		t.Fatal("a failed probe must report unknown")
	}
	_, _ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want the failed exec not repeated on the next beat", calls)
	}

	// The first retry comes well inside the server's wait for a first report,
	// never after the old 30-minute failure cooldown.
	h.backupVersionMu.Lock()
	firstDelay := time.Until(h.backupProtocolRetryAt)
	h.backupVersionMu.Unlock()
	if firstDelay <= 0 || firstDelay > backupProtocolRetryBase {
		t.Fatalf("first retry in %v, want within %v", firstDelay, backupProtocolRetryBase)
	}

	// Repeated failures back off, capped.
	for i := 0; i < 12; i++ {
		h.backupVersionMu.Lock()
		h.backupProtocolRetryAt = time.Now().Add(-time.Second)
		h.backupVersionMu.Unlock()
		_, _ = h.backupProtocols()
	}
	h.backupVersionMu.Lock()
	cappedDelay := time.Until(h.backupProtocolRetryAt)
	h.backupVersionMu.Unlock()
	if cappedDelay <= firstDelay || cappedDelay > backupProtocolRetryMax {
		t.Fatalf("retry delay after repeated failures = %v, want > %v and <= %v", cappedDelay, firstDelay, backupProtocolRetryMax)
	}
	if backupProtocolRetryMax >= backupVersionProbeCooldown {
		t.Fatalf("retry cap %v must stay below the version-probe cooldown %v", backupProtocolRetryMax, backupVersionProbeCooldown)
	}

	// Recovery: the next due probe answers and is reported and cached.
	outcome = backupProbeOK
	h.backupVersionMu.Lock()
	h.backupProtocolRetryAt = time.Now().Add(-time.Second)
	h.backupVersionMu.Unlock()
	want := backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}
	if got, known := h.backupProtocols(); !known || got != want {
		t.Fatalf("protocols after recovery = (%+v, known %v), want %+v", got, known, want)
	}
	before := calls
	_, _ = h.backupProtocols()
	if calls != before {
		t.Fatal("a recovered answer must be cached")
	}

	// A later failure after a helper swap backs off from the start again.
	outcome = backupProbeFailed
	h.invalidateBackupVersionCache()
	_, _ = h.backupProtocols()
	h.backupVersionMu.Lock()
	restartDelay := time.Until(h.backupProtocolRetryAt)
	h.backupVersionMu.Unlock()
	if restartDelay > backupProtocolRetryBase {
		t.Fatalf("retry delay after a helper swap = %v, want the backoff reset to %v", restartDelay, backupProtocolRetryBase)
	}
}

func TestBackupProtocols_NotInstalledAndUnresolvedAreNeverCached(t *testing.T) {
	for _, outcome := range []backupProbeOutcome{backupProbeNotInstalled, backupProbeUnresolved} {
		calls := 0
		h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
			calls++
			return backupipc.ProtocolInfo{}, outcome
		}}
		_, _ = h.backupProtocols()
		_, _ = h.backupProtocols()
		if calls != 2 {
			t.Fatalf("outcome %v: probe calls = %d, want every beat to look again (no exec is paid)", outcome, calls)
		}
	}
}

// The probe-failure log fires once per change of state, not once per beat.
func TestBackupProtocols_LogsOncePerStateChange(t *testing.T) {
	outcome := backupProbeFailed
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		return backupipc.ProtocolInfo{BackupWriteProtocolVersion: 1}, outcome
	}}
	var logged []string
	h.backupProtocolStateLogger = func(state string) { logged = append(logged, state) }

	due := func() {
		h.backupVersionMu.Lock()
		h.backupProtocolRetryAt = time.Time{}
		h.backupVersionMu.Unlock()
	}
	for i := 0; i < 3; i++ {
		due()
		_, _ = h.backupProtocols()
	}
	outcome = backupProbeNotInstalled
	for i := 0; i < 3; i++ {
		due()
		_, _ = h.backupProtocols()
	}
	outcome = backupProbeOK
	for i := 0; i < 3; i++ {
		due()
		_, _ = h.backupProtocols()
	}
	outcome = backupProbeFailed
	h.invalidateBackupVersionCache()
	_, _ = h.backupProtocols()

	want := []string{"unknown:probe_failed", "unknown:not_installed", "known", "unknown:probe_failed"}
	if len(logged) != len(want) {
		t.Fatalf("logged states = %v, want %v", logged, want)
	}
	for i := range want {
		if logged[i] != want[i] {
			t.Fatalf("logged states = %v, want %v", logged, want)
		}
	}
}

func TestBackupProtocols_ExecsInstalledHelper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stand-in for the helper binary")
	}
	dir := t.TempDir()
	helper := filepath.Join(dir, "breeze-backup")
	script := "#!/bin/sh\nif [ \"$1\" = \"--protocol-info\" ]; then echo '{\"backupReadProtocolVersion\":1,\"backupIntegrityProtocolVersion\":2,\"backupWriteProtocolVersion\":1}'; exit 0; fi\necho \"Error: unknown flag: $1\" >&2\nexit 1\n"
	if err := os.WriteFile(helper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{backupBinaryPath: helper}
	want := backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}
	if got, known := h.backupProtocols(); !known || got != want {
		t.Fatalf("protocols = (%+v, known %v), want %+v from the installed helper", got, known, want)
	}

	// A helper that reports only the read protocol (predates the others).
	readOnly := filepath.Join(dir, "read-only-breeze-backup")
	if err := os.WriteFile(readOnly, []byte("#!/bin/sh\necho '{\"backupReadProtocolVersion\":1}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	h = &Heartbeat{backupBinaryPath: readOnly}
	if got, known := h.backupProtocols(); !known || got != (backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}) {
		t.Fatalf("protocols = (%+v, known %v), want read 1 only", got, known)
	}

	// A helper that predates the flag answers "unknown flag": a real all-0,
	// cached like any answer until a helper swap.
	old := filepath.Join(dir, "old-breeze-backup")
	if err := os.WriteFile(old, []byte("#!/bin/sh\necho \"Error: unknown flag: $1\" >&2\necho \"Usage:\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	h = &Heartbeat{backupBinaryPath: old}
	if got, known := h.backupProtocols(); !known || got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = (%+v, known %v), want a known all-0 for a helper without --protocol-info", got, known)
	}

	unknownCases := []struct {
		name   string
		script string
	}{
		{"crashes", "#!/bin/sh\necho 'panic: runtime error' >&2\nexit 2\n"},
		{"exits non-zero without output", "#!/bin/sh\nexit 1\n"},
		{"prints garbage", "#!/bin/sh\necho 'not json'\n"},
	}
	for _, tc := range unknownCases {
		path := filepath.Join(dir, "unknown-"+filepath.Base(tc.name))
		if err := os.WriteFile(path, []byte(tc.script), 0o755); err != nil {
			t.Fatal(err)
		}
		h = &Heartbeat{backupBinaryPath: path}
		if got, known := h.backupProtocols(); known || got != (backupipc.ProtocolInfo{}) {
			t.Fatalf("%s: protocols = (%+v, known %v), want unknown", tc.name, got, known)
		}
	}

	// Not installed yet: unknown.
	h = &Heartbeat{backupBinaryPath: filepath.Join(dir, "missing")}
	if got, known := h.backupProtocols(); known || got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = (%+v, known %v), want unknown when not installed", got, known)
	}
}

func TestBackupProtocols_TimeoutIsUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stand-in for the helper binary")
	}
	dir := t.TempDir()
	slow := filepath.Join(dir, "slow-breeze-backup")
	if err := os.WriteFile(slow, []byte("#!/bin/sh\nexec sleep 5\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{backupBinaryPath: slow, backupProtocolTimeout: 200 * time.Millisecond}
	if got, known := h.backupProtocols(); known || got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = (%+v, known %v), want unknown for a probe that timed out", got, known)
	}
}

func TestHeartbeatPayloadBackupProtocolVersionsJSON(t *testing.T) {
	topLevel := func(p HeartbeatPayload) map[string]any {
		t.Helper()
		raw, err := json.Marshal(p)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		return m
	}
	keys := []string{"backupReadProtocolVersion", "backupIntegrityProtocolVersion", "backupWriteProtocolVersion"}

	// Known versions travel as numbers at the top level.
	p := HeartbeatPayload{}
	p.setBackupProtocols(backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}, true)
	m := topLevel(p)
	for key, want := range map[string]float64{
		"backupReadProtocolVersion":      1,
		"backupIntegrityProtocolVersion": 2,
		"backupWriteProtocolVersion":     1,
	} {
		if v, ok := m[key]; !ok || v != want {
			t.Fatalf("%s = %v (present %v), want %v at the top level", key, v, ok, want)
		}
	}

	// A real 0 is sent as 0, not omitted.
	p = HeartbeatPayload{}
	p.setBackupProtocols(backupipc.ProtocolInfo{}, true)
	m = topLevel(p)
	for _, key := range keys {
		if v, ok := m[key]; !ok || v != float64(0) {
			t.Fatalf("%s = %v (present %v), want an explicit 0 for a helper that answered 0", key, v, ok)
		}
	}

	// Unknown is an explicit null: present, distinct from 0 and from absent
	// (absent is what an agent older than this report sends).
	p = HeartbeatPayload{}
	p.setBackupProtocols(backupipc.ProtocolInfo{BackupWriteProtocolVersion: 1}, false)
	m = topLevel(p)
	for _, key := range keys {
		if v, ok := m[key]; !ok || v != nil {
			t.Fatalf("%s = %v (present %v), want an explicit null when the helper did not answer", key, v, ok)
		}
	}
}
