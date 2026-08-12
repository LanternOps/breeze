package heartbeat

import (
	"testing"
	"time"
)

func TestParseBackupVersion(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{
			name: "single version line",
			out:  "Breeze Backup Version: 0.82.1\n",
			want: "0.82.1",
		},
		{
			name: "extra surrounding whitespace",
			out:  "  Breeze Backup Version:    0.69.0  \n",
			want: "0.69.0",
		},
		{
			name: "no version line",
			out:  "some unexpected output\n",
			want: "",
		},
		{
			name: "empty output",
			out:  "",
			want: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseBackupVersion(tt.out); got != tt.want {
				t.Errorf("parseBackupVersion(%q) = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}

func TestInstalledBackupVersion_ReadsAndCaches(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		backupVersionReader: func() (string, backupProbeOutcome) {
			calls++
			return "0.69.0", backupProbeOK
		},
	}

	if got := h.installedBackupVersion(); got != "0.69.0" {
		t.Fatalf("expected on-disk version 0.69.0, got %q", got)
	}
	// Second call must hit the cache, not re-exec the binary.
	if got := h.installedBackupVersion(); got != "0.69.0" {
		t.Fatalf("expected cached version 0.69.0, got %q", got)
	}
	if calls != 1 {
		t.Fatalf("expected on-disk reader to be called exactly once (cached after), got %d", calls)
	}
}

func TestInstalledBackupVersion_CachesStableNotInstalled(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		// backupProbeNotInstalled models "backup helper not installed" — a
		// durably-cached steady state.
		backupVersionReader: func() (string, backupProbeOutcome) {
			calls++
			return "", backupProbeNotInstalled
		},
	}

	if got := h.installedBackupVersion(); got != "" {
		t.Fatalf("expected empty version, got %q", got)
	}
	if got := h.installedBackupVersion(); got != "" {
		t.Fatalf("expected empty version on second call, got %q", got)
	}
	// A durable "not installed" result is cached so we don't exec every tick.
	if calls != 1 {
		t.Fatalf("expected reader called once for a stable not-installed result, got %d", calls)
	}
}

// TestInstalledBackupVersion_UnresolvedPath_NeverCachedRetriesEveryCall is
// Finding 6: a transient os.Executable()/path-resolution failure must not be
// mistaken for a stable "not installed" and silently suppress backup-version
// telemetry for the rest of the process lifetime. It is retried on every
// call, with no cooldown (unlike backupProbeFailed below).
func TestInstalledBackupVersion_UnresolvedPath_NeverCachedRetriesEveryCall(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		backupVersionReader: func() (string, backupProbeOutcome) {
			calls++
			if calls >= 3 {
				return "0.82.1", backupProbeOK // recovers on the 3rd attempt
			}
			return "", backupProbeUnresolved
		},
	}

	if got := h.installedBackupVersion(); got != "" {
		t.Fatalf("attempt 1: expected empty, got %q", got)
	}
	if got := h.installedBackupVersion(); got != "" {
		t.Fatalf("attempt 2: expected empty (retried, not cached), got %q", got)
	}
	if got := h.installedBackupVersion(); got != "0.82.1" {
		t.Fatalf("attempt 3: expected recovered version 0.82.1, got %q", got)
	}
	if calls != 3 {
		t.Fatalf("expected reader retried each call until a stable read (3 calls), got %d", calls)
	}
	// Now it's cached — a 4th call must not re-read.
	if got := h.installedBackupVersion(); got != "0.82.1" {
		t.Fatalf("attempt 4: expected cached 0.82.1, got %q", got)
	}
	if calls != 3 {
		t.Fatalf("expected stable read to be cached (still 3 calls), got %d", calls)
	}
}

// TestInstalledBackupVersion_ProbeFailed_CachedForCooldownWindow is Finding
// 7(a): a failed --version exec (binary present but broken/legacy) must not
// be re-exec'd on every heartbeat — up to backupVersionReadTimeout of
// synchronous stall per tick, forever, for a binary that will never answer.
// It is cached for backupVersionProbeCooldown instead.
func TestInstalledBackupVersion_ProbeFailed_CachedForCooldownWindow(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		backupVersionReader: func() (string, backupProbeOutcome) {
			calls++
			return "", backupProbeFailed
		},
	}

	if got, outcome := h.installedBackupVersionOutcome(); got != "" || outcome != backupProbeFailed {
		t.Fatalf("call 1: expected (\"\", backupProbeFailed), got (%q, %v)", got, outcome)
	}
	if got, outcome := h.installedBackupVersionOutcome(); got != "" || outcome != backupProbeFailed {
		t.Fatalf("call 2 (within cooldown): expected cached (\"\", backupProbeFailed), got (%q, %v)", got, outcome)
	}
	if calls != 1 {
		t.Fatalf("expected the reader NOT to be re-invoked within the cooldown window, got %d calls", calls)
	}

	// Simulate the cooldown having elapsed.
	h.backupVersionMu.Lock()
	h.backupVersionProbeFailedAt = time.Now().Add(-backupVersionProbeCooldown - time.Second)
	h.backupVersionMu.Unlock()

	if got, outcome := h.installedBackupVersionOutcome(); got != "" || outcome != backupProbeFailed {
		t.Fatalf("call 3 (after cooldown): expected a fresh (\"\", backupProbeFailed), got (%q, %v)", got, outcome)
	}
	if calls != 2 {
		t.Fatalf("expected the reader to be re-invoked once the cooldown elapsed, got %d calls", calls)
	}
}

func TestResolveBackupBinaryPath_ConfiguredOverride(t *testing.T) {
	h := &Heartbeat{backupBinaryPath: "/opt/breeze/custom-backup"}
	got, err := h.resolveBackupBinaryPath()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "/opt/breeze/custom-backup" {
		t.Fatalf("expected configured path to win, got %q", got)
	}
}

func TestResolveBackupBinaryPath_DefaultsToSiblingOfSelf(t *testing.T) {
	h := &Heartbeat{}
	got, err := h.resolveBackupBinaryPath()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got == "" {
		t.Fatalf("expected a non-empty default path")
	}
}

func TestBackupBinaryName(t *testing.T) {
	tests := []struct {
		goos string
		want string
	}{
		{"windows", "breeze-backup.exe"},
		{"linux", "breeze-backup"},
		{"darwin", "breeze-backup"},
	}
	for _, tt := range tests {
		if got := backupBinaryName(tt.goos); got != tt.want {
			t.Errorf("backupBinaryName(%q) = %q, want %q", tt.goos, got, tt.want)
		}
	}
}

// TestInvalidateBackupVersionCache_ClearsAllCacheFields verifies the
// post-install invalidation resets every field installedBackupVersion checks,
// so the very next call re-execs the binary instead of returning the
// pre-install cached value.
func TestInvalidateBackupVersionCache_ClearsAllCacheFields(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		backupVersionReader: func() (string, backupProbeOutcome) {
			calls++
			return "0.90.0", backupProbeOK
		},
	}

	if got := h.installedBackupVersion(); got != "0.90.0" {
		t.Fatalf("expected 0.90.0, got %q", got)
	}
	if calls != 1 {
		t.Fatalf("expected 1 call before invalidation, got %d", calls)
	}

	h.invalidateBackupVersionCache()

	if got := h.installedBackupVersion(); got != "0.90.0" {
		t.Fatalf("expected reader to be re-invoked and return 0.90.0 again, got %q", got)
	}
	if calls != 2 {
		t.Fatalf("expected invalidation to force a second read, got %d calls", calls)
	}
}

// TestInvalidateBackupVersionCache_ClearsProbeFailedCooldown verifies that
// invalidating the cache after a fresh install (installBackupBinary's normal
// call) also clears a pending probe-failure cooldown — otherwise a binary
// that was JUST replaced (because its old version failed its probe, per
// Finding 7(b)) would still report the stale failure until the 30-minute
// cooldown expired, instead of reflecting the newly-installed binary on the
// very next read.
func TestInvalidateBackupVersionCache_ClearsProbeFailedCooldown(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		backupVersionReader: func() (string, backupProbeOutcome) {
			calls++
			if calls == 1 {
				return "", backupProbeFailed
			}
			return "1.4.0", backupProbeOK
		},
	}

	if got, outcome := h.installedBackupVersionOutcome(); got != "" || outcome != backupProbeFailed {
		t.Fatalf("expected initial probe failure, got (%q, %v)", got, outcome)
	}

	h.invalidateBackupVersionCache()

	got, outcome := h.installedBackupVersionOutcome()
	if outcome != backupProbeOK || got != "1.4.0" {
		t.Fatalf("expected the cooldown to be cleared and a fresh probe to run, got (%q, %v)", got, outcome)
	}
	if calls != 2 {
		t.Fatalf("expected a fresh probe after invalidation (not a cached cooldown hit), got %d calls", calls)
	}
}
