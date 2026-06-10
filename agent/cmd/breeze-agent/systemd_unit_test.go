package main

import (
	"os"
	"strings"
	"testing"
)

func TestParseUnitVersion(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantVer int
		wantOK  bool
	}{
		{"present", "[Service]\n# breeze-unit-version: 2\nType=simple\n", 2, true},
		{"present higher", "# breeze-unit-version: 7\n", 7, true},
		{"missing", "[Service]\nType=simple\n", 0, false},
		{"garbage value", "# breeze-unit-version: abc\n", 0, false},
		{"empty", "", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ver, ok := parseUnitVersion(tc.input)
			if ver != tc.wantVer || ok != tc.wantOK {
				t.Fatalf("parseUnitVersion(%q) = (%d,%v), want (%d,%v)", tc.input, ver, ok, tc.wantVer, tc.wantOK)
			}
		})
	}
}

func TestUnitNeedsReconcile(t *testing.T) {
	cases := []struct {
		name     string
		existing string
		want     int
		expect   bool
	}{
		{"missing marker -> reconcile", "[Service]\nType=simple\n", 2, true},
		{"older -> reconcile", "# breeze-unit-version: 1\n", 2, true},
		{"equal -> skip", "# breeze-unit-version: 2\n", 2, false},
		{"newer -> skip (no downgrade)", "# breeze-unit-version: 3\n", 2, false},
		{"garbage -> reconcile", "# breeze-unit-version: x\n", 2, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := unitNeedsReconcile(tc.existing, tc.want); got != tc.expect {
				t.Fatalf("unitNeedsReconcile(%q,%d) = %v, want %v", tc.existing, tc.want, got, tc.expect)
			}
		})
	}
}

func TestStaticUnitMatchesEmbedded(t *testing.T) {
	// Test runs with cwd = package dir (agent/cmd/breeze-agent).
	data, err := os.ReadFile("../../service/systemd/breeze-agent.service")
	if err != nil {
		t.Fatalf("read static unit: %v", err)
	}
	if string(data) != linuxUnit {
		got, want := string(data), linuxUnit
		i := 0
		for i < len(got) && i < len(want) && got[i] == want[i] {
			i++
		}
		t.Fatalf("static breeze-agent.service is not byte-identical to embedded linuxUnit "+
			"(first divergence at byte %d: file has %q, const has %q). "+
			"Keep them in sync (the auto-heal writes the embedded copy).",
			i, snippetAt(got, i), snippetAt(want, i))
	}
}

func TestUnitIsNotReHardened(t *testing.T) {
	forbidden := []string{
		// Directive-NAME prefixes, not specific values: ProtectSystem=full,
		// ProtectHome=tmpfs, PrivateTmp=yes etc. break children just the same.
		"ProtectSystem=",
		"ProtectHome=",
		"PrivateTmp=",
		"CapabilityBoundingSet",
		"AmbientCapabilities",
		// NoNewPrivileges=false is harmless (and was the old explicit value);
		// only forbid turning it ON, which breaks sudo/su in the terminal.
		"NoNewPrivileges=true",
		"NoNewPrivileges=yes",
	}
	for _, f := range forbidden {
		if strings.Contains(linuxUnit, f) {
			t.Errorf("linuxUnit re-introduced a sandbox directive that breaks the remote "+
				"terminal/scripts: %q (see the spec — do not re-add)", f)
		}
	}
	if _, ok := parseUnitVersion(linuxUnit); !ok {
		t.Errorf("linuxUnit is missing its %q marker", unitVersionPrefix)
	}
	if v, _ := parseUnitVersion(linuxUnit); v != currentUnitVersion {
		t.Errorf("linuxUnit marker version != currentUnitVersion (%d)", currentUnitVersion)
	}
}

// snippetAt returns a short window of s around byte offset i for error messages.
func snippetAt(s string, i int) string {
	end := i + 20
	if end > len(s) {
		end = len(s)
	}
	return s[i:end]
}
