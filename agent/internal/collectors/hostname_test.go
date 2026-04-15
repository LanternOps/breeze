package collectors

import (
	"errors"
	"runtime"
	"testing"
)

func staticSource(s string) hostnameSource {
	return func() string { return s }
}

func TestResolveHostnameFromSources(t *testing.T) {
	tests := []struct {
		name    string
		sources []hostnameSource
		want    string
		wantErr bool
	}{
		{
			name: "first source wins",
			sources: []hostnameSource{
				staticSource("desktop-01"),
				staticSource("fallback"),
			},
			want: "desktop-01",
		},
		{
			name: "empty first source falls through",
			sources: []hostnameSource{
				staticSource(""),
				staticSource("desktop-02"),
			},
			want: "desktop-02",
		},
		{
			name: "whitespace-only source is treated as empty",
			sources: []hostnameSource{
				staticSource("   \n\t"),
				staticSource("desktop-03"),
			},
			want: "desktop-03",
		},
		{
			name: "trailing whitespace is trimmed from result",
			sources: []hostnameSource{
				staticSource("desktop-04\r\n"),
			},
			want: "desktop-04",
		},
		{
			// Internal whitespace is preserved (not stripped by
			// TrimSpace). Server-side validation is the source of
			// truth for whether this is an acceptable hostname — we
			// just don't want the resolver silently mangling it.
			name: "internal whitespace is preserved",
			sources: []hostnameSource{
				staticSource("my host  \n"),
			},
			want: "my host",
		},
		{
			name: "nil source is skipped",
			sources: []hostnameSource{
				nil,
				staticSource("desktop-05"),
			},
			want: "desktop-05",
		},
		{
			name: "only last source has value",
			sources: []hostnameSource{
				staticSource(""),
				staticSource(" "),
				nil,
				staticSource("desktop-06"),
			},
			want: "desktop-06",
		},
		{
			name: "all empty returns failure",
			sources: []hostnameSource{
				staticSource(""),
				staticSource("   "),
				staticSource("\n"),
			},
			wantErr: true,
		},
		{
			name:    "no sources returns failure",
			sources: []hostnameSource{},
			wantErr: true,
		},
		{
			name:    "nil slice returns failure",
			sources: nil,
			wantErr: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveHostnameFromSources(tc.sources)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got nil (value=%q)", got)
				}
				if !errors.Is(err, errHostnameResolutionFailed) {
					t.Fatalf("expected errHostnameResolutionFailed, got %v", err)
				}
				if got != "" {
					t.Fatalf("expected empty result on error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// TestResolveHostnameFromSources_SourceOrderRespected verifies the
// resolver does NOT reorder sources — a later source must never
// override an earlier non-empty one. Regression guard against someone
// "optimizing" the loop to prefer e.g. WMI over os.Hostname().
func TestResolveHostnameFromSources_SourceOrderRespected(t *testing.T) {
	sources := []hostnameSource{
		staticSource("first"),
		staticSource("second"),
		staticSource("third"),
	}
	got, err := resolveHostnameFromSources(sources)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != "first" {
		t.Fatalf("got %q, want %q", got, "first")
	}
}

// TestResolveHostname_IntegrationRealOS sanity-checks that the real
// chain (os.Hostname → platform fallbacks) returns a value on a normal
// developer or CI machine. If this ever fails in CI it probably means
// the test environment is doing something exotic, not that the code is
// broken — but it's still a useful smoke signal.
func TestResolveHostname_IntegrationRealOS(t *testing.T) {
	got, err := resolveHostname()
	if err != nil {
		t.Fatalf("resolveHostname on real OS returned error: %v", err)
	}
	if got == "" {
		t.Fatalf("resolveHostname on real OS returned empty string")
	}
}

// TestHostnameSourceChain_FirstElementIsOsHostname guards the contract
// that os.Hostname() is always tried first. A regression here would
// mean we start hitting platform fallbacks (and their subprocess /
// syscall overhead) on every enroll, not just the broken cases.
func TestHostnameSourceChain_FirstElementIsOsHostname(t *testing.T) {
	chain := hostnameSourceChain()
	if len(chain) == 0 {
		t.Fatal("hostnameSourceChain returned empty slice")
	}
	// We can't compare function pointers across packages reliably, so
	// verify by behavior: the first source should match os.Hostname()'s
	// output on this machine.
	first := chain[0]()
	want := osHostname()
	if first != want {
		t.Fatalf("first source returned %q, expected os.Hostname()=%q", first, want)
	}
}

// TestCollectSystemInfo_HostnameFallbackFailureLeavesEmpty locks in the
// contract that the enroll guard in cmd/breeze-agent/main.go relies on:
// when the hostname resolver fails, CollectSystemInfo must leave
// info.Hostname empty rather than silently keeping a stale value from
// gopsutil. The guard's assertHostnameNonEmpty check then catches it
// and aborts enrollment. See issue #439.
//
// Skipped on darwin because the scutil LocalHostName override can still
// populate info.Hostname even when our resolver fails — that's the
// intended darwin behavior and not what this test is about.
func TestCollectSystemInfo_HostnameFallbackFailureLeavesEmpty(t *testing.T) {
	if runtime.GOOS == "darwin" {
		t.Skip("darwin uses scutil LocalHostName as an additional hostname source")
	}
	orig := resolveHostnameFn
	t.Cleanup(func() { resolveHostnameFn = orig })
	resolveHostnameFn = func() (string, error) {
		return "", errHostnameResolutionFailed
	}

	c := NewHardwareCollector()
	info, err := c.CollectSystemInfo()
	if err != nil {
		t.Fatalf("CollectSystemInfo returned error: %v", err)
	}
	if info == nil {
		t.Fatal("CollectSystemInfo returned nil info")
	}
	if info.Hostname != "" {
		t.Fatalf("expected empty hostname on resolver failure, got %q", info.Hostname)
	}
}
