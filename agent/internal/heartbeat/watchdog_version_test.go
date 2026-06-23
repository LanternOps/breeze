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
		watchdogVersionReader: func() string {
			calls++
			return "0.69.0"
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
		watchdogVersionReader: func() string {
			calls++
			return "0.69.0"
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

func TestInstalledWatchdogVersion_CachesEmptyRead(t *testing.T) {
	calls := 0
	h := &Heartbeat{
		watchdogVersionReader: func() string {
			calls++
			return ""
		},
	}

	if got := h.installedWatchdogVersion(); got != "" {
		t.Fatalf("expected empty version, got %q", got)
	}
	if got := h.installedWatchdogVersion(); got != "" {
		t.Fatalf("expected empty version on second call, got %q", got)
	}
	// An empty (failed/unknown) read is still cached so we don't exec every tick.
	if calls != 1 {
		t.Fatalf("expected reader called once even for empty result, got %d", calls)
	}
}
