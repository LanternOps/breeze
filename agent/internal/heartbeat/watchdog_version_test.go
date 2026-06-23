package heartbeat

import "testing"

func TestParseWatchdogStatusVersion(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want string
	}{
		{
			name: "leading version line",
			out:  "Watchdog Version: 0.82.1\nAgent State: online\n",
			want: "0.82.1",
		},
		{
			name: "version not first line",
			out:  "Agent State: no state file found\nWatchdog Version: 1.2.3\n",
			want: "1.2.3",
		},
		{
			name: "extra surrounding whitespace",
			out:  "  Watchdog Version:    0.69.0  \n",
			want: "0.69.0",
		},
		{
			name: "no version line",
			out:  "Agent State: online\nIPC Socket: /tmp/sock (exists)\n",
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
			if got := parseWatchdogStatusVersion(tt.out); got != tt.want {
				t.Errorf("parseWatchdogStatusVersion(%q) = %q, want %q", tt.out, got, tt.want)
			}
		})
	}
}

func TestInstalledWatchdogVersion_PrefersInMemorySwap(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		watchdogInstalledVersion: "0.82.1",
		watchdogVersionReader: func() (string, bool) {
			calls++
			return "0.69.0", true
		},
	}

	if got := h.installedWatchdogVersion(); got != "0.82.1" {
		t.Fatalf("expected in-memory swap version 0.82.1, got %q", got)
	}
	if calls != 0 {
		t.Fatalf("expected on-disk reader NOT to be called when swap version is known, got %d calls", calls)
	}
}

func TestInstalledWatchdogVersion_ReadsAndCaches(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		watchdogVersionReader: func() (string, bool) {
			calls++
			return "0.69.0", true
		},
	}

	if got := h.installedWatchdogVersion(); got != "0.69.0" {
		t.Fatalf("expected on-disk version 0.69.0, got %q", got)
	}
	// Second call must hit the cache, not re-exec the binary.
	if got := h.installedWatchdogVersion(); got != "0.69.0" {
		t.Fatalf("expected cached version 0.69.0, got %q", got)
	}
	if calls != 1 {
		t.Fatalf("expected on-disk reader to be called exactly once (cached after), got %d", calls)
	}
}

func TestInstalledWatchdogVersion_CachesStableEmptyRead(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		// stable=true models "watchdog not installed" — a steady state.
		watchdogVersionReader: func() (string, bool) {
			calls++
			return "", true
		},
	}

	if got := h.installedWatchdogVersion(); got != "" {
		t.Fatalf("expected empty version, got %q", got)
	}
	if got := h.installedWatchdogVersion(); got != "" {
		t.Fatalf("expected empty version on second call, got %q", got)
	}
	// A STABLE empty result (not installed) is cached so we don't exec every tick.
	if calls != 1 {
		t.Fatalf("expected reader called once for a stable empty result, got %d", calls)
	}
}

func TestInstalledWatchdogVersion_DoesNotCacheTransientFailure(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		// stable=false models "installed but unreadable" — a transient failure
		// (exec error / timeout) that must NOT be cached, else a one-off blip
		// would suppress watchdog telemetry for the whole process lifetime
		// (the exact #1802 staleness this PR fixes).
		watchdogVersionReader: func() (string, bool) {
			calls++
			if calls >= 3 {
				return "0.82.1", true // recovers on the 3rd attempt
			}
			return "", false
		},
	}

	if got := h.installedWatchdogVersion(); got != "" {
		t.Fatalf("attempt 1: expected empty, got %q", got)
	}
	if got := h.installedWatchdogVersion(); got != "" {
		t.Fatalf("attempt 2: expected empty (retried, not cached), got %q", got)
	}
	if got := h.installedWatchdogVersion(); got != "0.82.1" {
		t.Fatalf("attempt 3: expected recovered version 0.82.1, got %q", got)
	}
	if calls != 3 {
		t.Fatalf("expected reader retried each tick until a stable read (3 calls), got %d", calls)
	}
	// Now it's cached — a 4th call must not re-read.
	if got := h.installedWatchdogVersion(); got != "0.82.1" {
		t.Fatalf("attempt 4: expected cached 0.82.1, got %q", got)
	}
	if calls != 3 {
		t.Fatalf("expected stable read to be cached (still 3 calls), got %d", calls)
	}
}
