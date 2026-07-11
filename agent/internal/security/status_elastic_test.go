package security

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func staticProbes(installed, processRunning, unitActive bool, version string) linuxElasticProbes {
	return linuxElasticProbes{
		fileExists:     func(path string) bool { return installed && path == linuxElasticEndpointBinary },
		processRunning: func(string) bool { return processRunning },
		unitActive:     func(string) bool { return unitActive },
		binaryVersion:  func(string) string { return version },
	}
}

func TestDetectLinuxElasticDefend(t *testing.T) {
	cases := []struct {
		name           string
		installed      bool
		processRunning bool
		unitActive     bool
		version        string
		wantDetected   bool
		wantRTP        bool
		wantVersion    string
		wantPath       string
	}{
		{
			name:      "installed and process running",
			installed: true, processRunning: true,
			version:      "8.14.1",
			wantDetected: true, wantRTP: true,
			wantVersion: "8.14.1",
			wantPath:    linuxElasticEndpointBinary,
		},
		{
			name:      "installed, process not found but systemd unit active",
			installed: true, unitActive: true,
			wantDetected: true, wantRTP: true,
			wantPath: linuxElasticEndpointBinary,
		},
		{
			name:         "installed but not running",
			installed:    true,
			wantDetected: true, wantRTP: false,
			wantPath: linuxElasticEndpointBinary,
		},
		{
			name:           "non-default install prefix, process running",
			processRunning: true,
			wantDetected:   true, wantRTP: true,
		},
		{
			name:         "not installed, not running",
			wantDetected: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			product, version, err := detectLinuxElasticDefend(staticProbes(tc.installed, tc.processRunning, tc.unitActive, tc.version))

			if !tc.wantDetected {
				if !errors.Is(err, ErrNotSupported) {
					t.Fatalf("expected ErrNotSupported, got product=%v err=%v", product, err)
				}
				return
			}

			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if product == nil {
				t.Fatal("expected a product, got nil")
			}
			if product.Provider != "elastic_defend" {
				t.Fatalf("Provider = %q, want elastic_defend", product.Provider)
			}
			if product.DisplayName != "Elastic Defend" {
				t.Fatalf("DisplayName = %q, want Elastic Defend", product.DisplayName)
			}
			if !product.Registered {
				t.Fatal("Registered = false, want true")
			}
			if product.RealTimeProtection != tc.wantRTP {
				t.Fatalf("RealTimeProtection = %v, want %v", product.RealTimeProtection, tc.wantRTP)
			}
			if version != tc.wantVersion {
				t.Fatalf("version = %q, want %q", version, tc.wantVersion)
			}
			if product.PathToSignedProduct != tc.wantPath {
				t.Fatalf("PathToSignedProduct = %q, want %q", product.PathToSignedProduct, tc.wantPath)
			}
			// Deliberate contract: definitions freshness is not locally
			// observable for Elastic Defend, so it must never be asserted true.
			if product.DefinitionsUpToDate {
				t.Fatal("DefinitionsUpToDate = true, want false (freshness is not locally observable)")
			}
		})
	}
}

func TestLinuxUnitStateRunning(t *testing.T) {
	cases := []struct {
		name     string
		state    string
		zeroExit bool
		want     bool
	}{
		{"active with zero exit", "active", true, true},
		// A non-zero exit that still prints "active" is an ambiguous probe
		// (mirrors the firewall-cmd hardening) — do not trust it.
		{"active with non-zero exit", "active", false, false},
		{"activating counts as running", "activating", false, true},
		{"reloading counts as running", "reloading", true, true},
		{"inactive", "inactive", false, false},
		{"failed", "failed", false, false},
		{"dbus error output", "Failed to connect to bus: No such file or directory", false, false},
		{"empty output", "", false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := linuxUnitStateRunning(tc.state, tc.zeroExit); got != tc.want {
				t.Fatalf("linuxUnitStateRunning(%q, %v) = %v, want %v", tc.state, tc.zeroExit, got, tc.want)
			}
		})
	}
}

func TestDetectLinuxElasticDefendVersionOnlyProbedWhenInstalled(t *testing.T) {
	probes := staticProbes(false, true, false, "unused")
	probes.binaryVersion = func(string) string {
		t.Fatal("binaryVersion must not be probed when the binary is absent")
		return ""
	}
	if _, version, err := detectLinuxElasticDefend(probes); err != nil || version != "" {
		t.Fatalf("got version=%q err=%v, want empty version and nil err", version, err)
	}
}

func TestLinuxProcessRunning(t *testing.T) {
	writeProc := func(t *testing.T, root, pid string, cmdline []byte) {
		t.Helper()
		dir := filepath.Join(root, pid)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "cmdline"), cmdline, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		name  string
		setup func(t *testing.T, root string)
		query string
		want  bool
	}{
		{
			name: "match on argv0 basename with args",
			setup: func(t *testing.T, root string) {
				writeProc(t, root, "123", []byte("/opt/Elastic/Endpoint/elastic-endpoint\x00run\x00"))
			},
			query: "elastic-endpoint",
			want:  true,
		},
		{
			name: "full 16-char name matches (comm would truncate at 15)",
			setup: func(t *testing.T, root string) {
				writeProc(t, root, "77", []byte("elastic-endpoint\x00"))
			},
			query: "elastic-endpoint",
			want:  true,
		},
		{
			name: "substring of another process does not match",
			setup: func(t *testing.T, root string) {
				writeProc(t, root, "88", []byte("/usr/bin/elastic-endpoint-helper\x00"))
			},
			query: "elastic-endpoint",
			want:  false,
		},
		{
			name: "non-numeric proc entries and empty cmdline are skipped",
			setup: func(t *testing.T, root string) {
				writeProc(t, root, "sys", []byte("elastic-endpoint\x00")) // not a pid dir
				writeProc(t, root, "99", nil)                             // kernel thread: empty cmdline
			},
			query: "elastic-endpoint",
			want:  false,
		},
		{
			name:  "missing proc root",
			setup: func(t *testing.T, root string) { _ = os.RemoveAll(root) },
			query: "elastic-endpoint",
			want:  false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			tc.setup(t, root)
			if got := linuxProcessRunning(root, tc.query); got != tc.want {
				t.Fatalf("linuxProcessRunning(%q) = %v, want %v", tc.query, got, tc.want)
			}
		})
	}
}

func TestParseElasticVersion(t *testing.T) {
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{"typical output", "Endpoint Security, version 8.14.1", "8.14.1"},
		{"version with build metadata trailing lines", "Elastic Endpoint 9.0.2\nbuild: abc123", "9.0.2"},
		{"two-part version", "version 8.14", "8.14"},
		{"no version present", "usage: elastic-endpoint <command>", ""},
		{"empty output", "", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseElasticVersion(tc.output); got != tc.want {
				t.Fatalf("parseElasticVersion(%q) = %q, want %q", tc.output, got, tc.want)
			}
		})
	}
}
