package heartbeat

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestParseBackupReadProtocol(t *testing.T) {
	cases := []struct {
		name   string
		out    string
		want   int
		wantOK bool
	}{
		{"version 1", `{"backupReadProtocolVersion":1}` + "\n", 1, true},
		{"future version passes through", `{"backupReadProtocolVersion":3}`, 3, true},
		{"explicit zero", `{"backupReadProtocolVersion":0}`, 0, true},
		{"key absent", `{"other":1}`, 0, true},
		{"negative", `{"backupReadProtocolVersion":-1}`, 0, false},
		{"not json", "Error: unknown flag: --protocol-info\n", 0, false},
		{"wrong type", `{"backupReadProtocolVersion":"1"}`, 0, false},
		{"empty", "", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseBackupReadProtocol(tc.out)
			if got != tc.want || ok != tc.wantOK {
				t.Fatalf("parseBackupReadProtocol(%q) = (%d, %v), want (%d, %v)", tc.out, got, ok, tc.want, tc.wantOK)
			}
		})
	}
}

func TestBackupReadProtocolVersion_CachesSuccessAndInvalidatesOnInstall(t *testing.T) {
	calls := 0
	version := 1
	h := &Heartbeat{backupReadProtocolReader: func() (int, backupProbeOutcome) {
		calls++
		return version, backupProbeOK
	}}
	if got := h.backupReadProtocolVersion(); got != 1 {
		t.Fatalf("version = %d, want 1", got)
	}
	_ = h.backupReadProtocolVersion()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want a cached read", calls)
	}
	// A helper update (reconcile/prefetch swap) invalidates the backup
	// version cache; the protocol must be re-read from the new binary.
	version = 0
	h.invalidateBackupVersionCache()
	if got := h.backupReadProtocolVersion(); got != 0 {
		t.Fatalf("version after downgrade = %d, want 0", got)
	}
	if calls != 2 {
		t.Fatalf("probe calls = %d, want a re-read after install", calls)
	}
}

func TestBackupReadProtocolVersion_FailureReportsZeroWithCooldown(t *testing.T) {
	calls := 0
	h := &Heartbeat{backupReadProtocolReader: func() (int, backupProbeOutcome) {
		calls++
		return 0, backupProbeFailed
	}}
	if got := h.backupReadProtocolVersion(); got != 0 {
		t.Fatalf("version = %d, want 0 for a helper that cannot report", got)
	}
	_ = h.backupReadProtocolVersion()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want the failure cached for the cooldown", calls)
	}
	h.backupVersionMu.Lock()
	h.backupReadProtocolFailedAt = time.Now().Add(-2 * backupVersionProbeCooldown)
	h.backupVersionMu.Unlock()
	_ = h.backupReadProtocolVersion()
	if calls != 2 {
		t.Fatalf("probe calls = %d, want a retry after the cooldown", calls)
	}
}

func TestBackupReadProtocolVersion_ExecsInstalledHelper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stand-in for the helper binary")
	}
	dir := t.TempDir()
	helper := filepath.Join(dir, "breeze-backup")
	script := "#!/bin/sh\nif [ \"$1\" = \"--protocol-info\" ]; then echo '{\"backupReadProtocolVersion\":1}'; exit 0; fi\necho \"Error: unknown flag: $1\" >&2\nexit 1\n"
	if err := os.WriteFile(helper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{backupBinaryPath: helper}
	if got := h.backupReadProtocolVersion(); got != 1 {
		t.Fatalf("version = %d, want 1 from the installed helper", got)
	}

	// A helper that predates the flag exits non-zero: reported as 0.
	old := filepath.Join(dir, "old-breeze-backup")
	if err := os.WriteFile(old, []byte("#!/bin/sh\necho \"Error: unknown flag: $1\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	h = &Heartbeat{backupBinaryPath: old}
	if got := h.backupReadProtocolVersion(); got != 0 {
		t.Fatalf("version = %d, want 0 for a helper without --protocol-info", got)
	}

	// Not installed: 0.
	h = &Heartbeat{backupBinaryPath: filepath.Join(dir, "missing")}
	if got := h.backupReadProtocolVersion(); got != 0 {
		t.Fatalf("version = %d, want 0 when not installed", got)
	}
}

func TestHeartbeatPayloadBackupReadProtocolVersionJSON(t *testing.T) {
	raw, err := json.Marshal(HeartbeatPayload{BackupReadProtocolVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if v, ok := m["backupReadProtocolVersion"]; !ok || v != float64(1) {
		t.Fatalf("backupReadProtocolVersion = %v (present %v), want 1 at the top level", v, ok)
	}
	raw, _ = json.Marshal(HeartbeatPayload{})
	m = nil
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["backupReadProtocolVersion"]; ok {
		t.Fatal("backupReadProtocolVersion must be omitted when the helper reports none")
	}
}
