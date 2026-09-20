package syscleanup

import (
	"strings"
	"testing"
)

// Argv is built from constants. These table tests are the proof that no client
// string can reach one (spec §10 item 7).

func TestPackageCleanArgsPerManager(t *testing.T) {
	cases := []struct {
		pm   linuxPackageManager
		want []string
	}{
		{linuxPackageManager{name: "apt", binary: "/usr/bin/apt-get"}, []string{"clean"}},
		{linuxPackageManager{name: "dnf", binary: "/usr/bin/dnf"}, []string{"clean", "all"}},
		{linuxPackageManager{name: "yum", binary: "/usr/bin/yum"}, []string{"clean", "all"}},
	}
	for _, tc := range cases {
		got := packageCleanArgs(tc.pm)
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("packageCleanArgs(%s) = %v, want %v", tc.pm.name, got, tc.want)
		}
	}
}

func TestPackageAutoremoveArgsPerManager(t *testing.T) {
	cases := []struct {
		pm   linuxPackageManager
		want []string
	}{
		{linuxPackageManager{name: "apt", binary: "/usr/bin/apt-get"}, []string{"-y", "autoremove"}},
		{linuxPackageManager{name: "dnf", binary: "/usr/bin/dnf"}, []string{"-y", "autoremove"}},
		{linuxPackageManager{name: "yum", binary: "/usr/bin/yum"}, []string{"-y", "autoremove"}},
	}
	for _, tc := range cases {
		got := packageAutoremoveArgs(tc.pm)
		if strings.Join(got, " ") != strings.Join(tc.want, " ") {
			t.Errorf("packageAutoremoveArgs(%s) = %v, want %v", tc.pm.name, got, tc.want)
		}
	}
}

func TestAutoremoveSimulationIsNonMutating(t *testing.T) {
	if got := strings.Join(aptAutoremoveSimulateArgs(), " "); got != "-s autoremove" {
		t.Fatalf("aptAutoremoveSimulateArgs() = %q, want \"-s autoremove\"", got)
	}
	if got := strings.Join(dnfAutoremoveSimulateArgs(), " "); got != "--assumeno autoremove" {
		t.Fatalf("dnfAutoremoveSimulateArgs() = %q, want \"--assumeno autoremove\"", got)
	}
	// An estimator that could delete a package would be a catastrophic bug in a
	// LIST call, which the UI presents as read-only.
	for _, args := range [][]string{aptAutoremoveSimulateArgs(), dnfAutoremoveSimulateArgs()} {
		for _, arg := range args {
			if arg == "-y" || arg == "--assumeyes" {
				t.Fatalf("simulation args %v contain an assume-yes flag", args)
			}
		}
	}
}

// The one bounded integer the client influences is clamped AGAIN here, so a
// forged command payload that bypassed the server's Zod bounds still cannot
// widen it (spec §5.3).
func TestJournalVacuumArgsClampTheRequestedSize(t *testing.T) {
	cases := []struct {
		in   int64
		want string
	}{
		{0, "--vacuum-size=268435456"}, // default 256 MiB
		{-1, "--vacuum-size=268435456"},
		{64 << 20, "--vacuum-size=67108864"},       // lower bound, allowed
		{(64 << 20) - 1, "--vacuum-size=67108864"}, // clamped up
		{1 << 30, "--vacuum-size=1073741824"},
		{4 << 30, "--vacuum-size=4294967296"}, // upper bound, allowed
		{1 << 60, "--vacuum-size=4294967296"}, // clamped down
	}
	for _, tc := range cases {
		got := journalVacuumArgs(tc.in)
		if len(got) != 1 || got[0] != tc.want {
			t.Errorf("journalVacuumArgs(%d) = %v, want [%q]", tc.in, got, tc.want)
		}
	}
	if got := strings.Join(journalDiskUsageArgs(), " "); got != "--disk-usage" {
		t.Fatalf("journalDiskUsageArgs() = %q", got)
	}
}

// Plan amendment 20 (spec §13 #14): `apt-get -s autoremove` prints NO
// "After this operation" line — that summary belongs to the interactive
// install path. The simulation names the packages on `Remv` lines and the
// size comes from dpkg.
func TestParseAptAutoremovePackages(t *testing.T) {
	const fixture = `NOTE: This is only a simulation!
      apt-get needs root privileges for real execution.
Reading package lists...
Building dependency tree...
The following packages will be REMOVED:
  linux-image-6.1.0-13-amd64 linux-headers-6.1.0-13-amd64
0 upgraded, 0 newly installed, 2 to remove and 0 not upgraded.
Remv linux-image-6.1.0-13-amd64 [6.1.55-1]
Remv linux-headers-6.1.0-13-amd64 [6.1.55-1]
`
	got, ok := parseAptAutoremovePackages(fixture)
	if !ok {
		t.Fatal("the documented -s autoremove shape must parse")
	}
	if strings.Join(got, ",") != "linux-image-6.1.0-13-amd64,linux-headers-6.1.0-13-amd64" {
		t.Fatalf("parseAptAutoremovePackages() = %v", got)
	}
}

// Nothing to remove: a KNOWN empty plan, which the caller turns into a known 0.
func TestParseAptAutoremovePackagesOnAnEmptyPlan(t *testing.T) {
	const fixture = `Reading package lists...
Building dependency tree...
0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.
`
	got, ok := parseAptAutoremovePackages(fixture)
	if !ok || len(got) != 0 {
		t.Fatalf("parseAptAutoremovePackages() = (%v, %v), want ([], true)", got, ok)
	}
}

// A shape the parser does not recognise must be UNKNOWN, never 0 (spec §7.1).
func TestParseAptAutoremovePackagesOnUnparseableOutput(t *testing.T) {
	if _, ok := parseAptAutoremovePackages("E: Could not open lock file\n"); ok {
		t.Fatal("unparseable apt output must be estimateKnown:false, not an empty plan")
	}
}

// A package name is passed straight back as an argv token to dpkg-query, so
// anything that is not a valid Debian package name is dropped rather than
// escaped.
func TestParseAptAutoremovePackagesRejectsHostileNames(t *testing.T) {
	const hostile = `Remv good-package [1.0]
Remv ../../etc/passwd [1.0]
Remv ; rm -rf / [1.0]
Remv --force-all [1.0]
`
	got, _ := parseAptAutoremovePackages(hostile)
	if strings.Join(got, ",") != "good-package" {
		t.Fatalf("parseAptAutoremovePackages() = %v, want only the well-formed name", got)
	}
}

// dpkg reports Installed-Size in KiB.
func TestParseDpkgInstalledSizes(t *testing.T) {
	got, ok := parseDpkgInstalledSizes("402000\n10240\n\n")
	if !ok || got != (402_000+10_240)*1024 {
		t.Fatalf("parseDpkgInstalledSizes() = (%d, %v), want (%d, true)", got, ok, (402_000+10_240)*1024)
	}
	if _, ok := parseDpkgInstalledSizes("dpkg-query: no packages found\n"); ok {
		t.Fatal("a dpkg error body must be unknown, not 0")
	}
	if got, ok := parseDpkgInstalledSizes(""); !ok || got != 0 {
		t.Fatalf("empty output for an empty package list = (%d, %v), want (0, true)", got, ok)
	}
}

func TestDpkgQueryArgs(t *testing.T) {
	got := dpkgQueryInstalledSizeArgs([]string{"a", "b"})
	want := []string{"-W", "-f=${Installed-Size}\n", "a", "b"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("dpkgQueryInstalledSizeArgs() = %v, want %v", got, want)
	}
}

// dnf exits NON-ZERO when it aborts under --assumeno. The estimator accepts
// exit 1 as long as the summary parses (spec §7.2).
func TestParseDnfAutoremoveFreedAcceptsTheAbortExit(t *testing.T) {
	const fixture = `Dependencies resolved.
================================================================================
 Package          Arch     Version              Repository            Size
================================================================================
Removing:
 kernel-core      x86_64   6.5.6-200.fc38       @updates             112 M
Transaction Summary
================================================================================
Remove  1 Package

Freed space: 1.2 G
Operation aborted.
`
	got, ok := parseDnfAutoremoveFreed(fixture, 1)
	if !ok || got != 1_288_490_188 {
		t.Fatalf("parseDnfAutoremoveFreed(exit 1) = (%d, %v), want (1288490188, true)", got, ok)
	}
	if _, ok := parseDnfAutoremoveFreed(fixture, 0); !ok {
		t.Fatal("exit 0 with a parsable summary must also be accepted")
	}
}

// dnf5 (Fedora 41+) changed the summary shape. Until a fixture is added it is
// honestly unknown (spec §7.2) — not silently zero.
func TestParseDnfAutoremoveFreedOnDnf5Output(t *testing.T) {
	const dnf5 = `Remove 3 Packages
Total size of inbound packages is 0 B. Need to download 0 B.
After this operation 145 MiB extra will be freed.
`
	if _, ok := parseDnfAutoremoveFreed(dnf5, 1); ok {
		t.Fatal("the dnf5 summary shape must report estimateKnown:false until a fixture is added")
	}
}

func TestParseJournalDiskUsage(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"Archived and active journals take up 1.2G in the file system.\n", 1_288_490_188, true},
		{"Archived and active journals take up 984.0M in the file system.\n", 1_031_798_784, true},
		{"Journals take up 512M in the file system.\n", 536_870_912, true},
		{"Failed to determine disk usage: Permission denied\n", 0, false},
		{"", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseJournalDiskUsage(tc.in)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseJournalDiskUsage(%q) = (%d, %v), want (%d, %v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

// The journal estimate is current usage MINUS the vacuum target, floored at 0
// — and it is an UPPER bound because only ARCHIVED journals are vacuumed
// (spec §7.2).
func TestJournalVacuumEstimateIsTheFlooredDifference(t *testing.T) {
	cases := []struct{ usage, target, want int64 }{
		{1_288_490_188, 268_435_456, 1_020_054_732},
		{100_000, 268_435_456, 0},
		{268_435_456, 268_435_456, 0},
	}
	for _, tc := range cases {
		if got := journalVacuumEstimate(tc.usage, tc.target); got != tc.want {
			t.Errorf("journalVacuumEstimate(%d, %d) = %d, want %d", tc.usage, tc.target, got, tc.want)
		}
	}
}

func TestLinuxActionsDeclareTheirRiskFlags(t *testing.T) {
	byID := map[string]ActionInfo{}
	for _, action := range linuxActions() {
		byID[action.ID()] = action.Describe()
	}
	for _, id := range []string{"linux_pkg_cache_clean", "linux_pkg_autoremove", "linux_journal_vacuum"} {
		info, ok := byID[id]
		if !ok {
			t.Fatalf("linuxActions() is missing %q", id)
		}
		if info.OS != "linux" {
			t.Errorf("%s: OS = %q, want linux", id, info.OS)
		}
		if info.Label == "" || info.Description == "" {
			t.Errorf("%s: label/description must be non-empty", id)
		}
	}
	// removes_packages is what gates the confirm dialog's second checkbox
	// (spec §7.2, §8). Only autoremove carries it.
	if !containsFold(byID["linux_pkg_autoremove"].RiskFlags, RiskRemovesPackages) {
		t.Error("linux_pkg_autoremove must carry the removes_packages risk flag")
	}
	for _, id := range []string{"linux_pkg_cache_clean", "linux_journal_vacuum"} {
		if containsFold(byID[id].RiskFlags, RiskRemovesPackages) {
			t.Errorf("%s must not carry removes_packages", id)
		}
	}
}
