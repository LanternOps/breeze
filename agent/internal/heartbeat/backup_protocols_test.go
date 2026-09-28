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
		{"keys absent", `{"other":1}`, backupipc.ProtocolInfo{}, true},
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
	if got := h.backupProtocols(); got != want {
		t.Fatalf("protocols = %+v, want %+v", got, want)
	}
	_ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want one probe for all three values", calls)
	}
}

func TestBackupProtocols_NegativeValuesReadAsZero(t *testing.T) {
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		return backupipc.ProtocolInfo{BackupReadProtocolVersion: -1, BackupIntegrityProtocolVersion: -2, BackupWriteProtocolVersion: -3}, backupProbeOK
	}}
	if got := h.backupProtocols(); got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = %+v, want all 0", got)
	}
}

func TestBackupProtocols_CachesSuccessAndInvalidatesOnInstall(t *testing.T) {
	calls := 0
	info := backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2, BackupWriteProtocolVersion: 1}
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return info, backupProbeOK
	}}
	if got := h.backupProtocols(); got != info {
		t.Fatalf("protocols = %+v, want %+v", got, info)
	}
	_ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want a cached read", calls)
	}
	// A helper update (reconcile/prefetch swap) invalidates the backup
	// version cache; every protocol must be re-read from the new binary.
	info = backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}
	h.invalidateBackupVersionCache()
	if got := h.backupProtocols(); got != info {
		t.Fatalf("protocols after a helper swap = %+v, want %+v", got, info)
	}
	if calls != 2 {
		t.Fatalf("probe calls = %d, want a re-read after install", calls)
	}
}

func TestBackupProtocols_FailureReportsZeroWithCooldown(t *testing.T) {
	calls := 0
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return backupipc.ProtocolInfo{BackupReadProtocolVersion: 1, BackupIntegrityProtocolVersion: 2}, backupProbeFailed
	}}
	if got := h.backupProtocols(); got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = %+v, want all 0 for a helper that cannot report", got)
	}
	_ = h.backupProtocols()
	if calls != 1 {
		t.Fatalf("probe calls = %d, want the failure cached for the cooldown", calls)
	}
	h.backupVersionMu.Lock()
	h.backupProtocolFailedAt = time.Now().Add(-2 * backupVersionProbeCooldown)
	h.backupVersionMu.Unlock()
	_ = h.backupProtocols()
	if calls != 2 {
		t.Fatalf("probe calls = %d, want a retry after the cooldown", calls)
	}
}

func TestBackupProtocols_UnresolvedIsNeverCached(t *testing.T) {
	calls := 0
	h := &Heartbeat{backupProtocolReader: func() (backupipc.ProtocolInfo, backupProbeOutcome) {
		calls++
		return backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}, backupProbeUnresolved
	}}
	if got := h.backupProtocols(); got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = %+v, want all 0 when the helper path is unresolved", got)
	}
	_ = h.backupProtocols()
	if calls != 2 {
		t.Fatalf("probe calls = %d, want every call to retry", calls)
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
	if got := h.backupProtocols(); got != want {
		t.Fatalf("protocols = %+v, want %+v from the installed helper", got, want)
	}

	// A helper that reports only the read protocol (predates the others).
	readOnly := filepath.Join(dir, "read-only-breeze-backup")
	if err := os.WriteFile(readOnly, []byte("#!/bin/sh\necho '{\"backupReadProtocolVersion\":1}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	h = &Heartbeat{backupBinaryPath: readOnly}
	if got := h.backupProtocols(); got != (backupipc.ProtocolInfo{BackupReadProtocolVersion: 1}) {
		t.Fatalf("protocols = %+v, want read 1 only", got)
	}

	// A helper that predates the flag exits non-zero: all 0.
	old := filepath.Join(dir, "old-breeze-backup")
	if err := os.WriteFile(old, []byte("#!/bin/sh\necho \"Error: unknown flag: $1\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	h = &Heartbeat{backupBinaryPath: old}
	if got := h.backupProtocols(); got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = %+v, want all 0 for a helper without --protocol-info", got)
	}

	// Not installed: all 0.
	h = &Heartbeat{backupBinaryPath: filepath.Join(dir, "missing")}
	if got := h.backupProtocols(); got != (backupipc.ProtocolInfo{}) {
		t.Fatalf("protocols = %+v, want all 0 when not installed", got)
	}
}

func TestHeartbeatPayloadBackupProtocolVersionsJSON(t *testing.T) {
	raw, err := json.Marshal(HeartbeatPayload{
		BackupReadProtocolVersion:      1,
		BackupIntegrityProtocolVersion: 2,
		BackupWriteProtocolVersion:     1,
	})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	for key, want := range map[string]float64{
		"backupReadProtocolVersion":      1,
		"backupIntegrityProtocolVersion": 2,
		"backupWriteProtocolVersion":     1,
	} {
		if v, ok := m[key]; !ok || v != want {
			t.Fatalf("%s = %v (present %v), want %v at the top level", key, v, ok, want)
		}
	}
	raw, _ = json.Marshal(HeartbeatPayload{})
	m = nil
	_ = json.Unmarshal(raw, &m)
	for _, key := range []string{"backupReadProtocolVersion", "backupIntegrityProtocolVersion", "backupWriteProtocolVersion"} {
		if _, ok := m[key]; ok {
			t.Fatalf("%s must be omitted when the helper reports 0", key)
		}
	}
}
