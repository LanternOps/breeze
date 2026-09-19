package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// The "Recovery media E2E (QEMU)" CI job builds this command and
// cmd/breeze-recovery-fakeserver, then boots the ISO. ci.yml runs that job only
// when a changed path is in .github/scripts/qemu-gate-paths.txt — a pinned copy
// of this module's transitive imports of the two commands, kept beside the
// classifier because the classifier runs in a sparse checkout with no Go
// toolchain. This test recomputes the set and fails when the file drifts in
// EITHER direction: a package the job now depends on that is not pinned would
// silently stop running the job for changes to it; a stale entry keeps running
// a 40-minute job for nothing.
func TestQEMUGatePathsMatchBackupDependencySet(t *testing.T) {
	const modulePrefix = "github.com/breeze-rmm/agent/"
	repoRoot, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	gateFile := filepath.Join(repoRoot, ".github", "scripts", "qemu-gate-paths.txt")

	cmd := exec.Command("go", "list", "-deps", "./cmd/breeze-backup", "./cmd/breeze-recovery-fakeserver")
	cmd.Dir = filepath.Join(repoRoot, "agent") // go test runs with cwd = this package
	cmd.Stderr = os.Stderr
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("go list -deps: %v", err)
	}
	want := map[string]bool{
		"agent/go.mod":          true,
		"agent/go.sum":          true,
		"agent/recovery-media/": true,
	}
	for _, pkg := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if strings.HasPrefix(pkg, modulePrefix) {
			want["agent/"+strings.TrimPrefix(pkg, modulePrefix)+"/"] = true
		}
	}
	if len(want) < 10 {
		t.Fatalf("dependency set is implausibly small (%d entries); go list output: %q", len(want), out)
	}

	f, err := os.Open(gateFile)
	if err != nil {
		t.Fatalf("open %s: %v", gateFile, err)
	}
	defer func() { _ = f.Close() }()
	got := map[string]bool{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.Index(line, "#"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line != "" {
			got[line] = true
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}

	var missing, stale []string
	for p := range want {
		if !got[p] {
			missing = append(missing, p)
		}
	}
	for p := range got {
		if !want[p] {
			stale = append(stale, p)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	if len(missing)+len(stale) > 0 {
		t.Fatalf("%s drifted from `go list -deps ./cmd/breeze-backup ./cmd/breeze-recovery-fakeserver`.\n"+
			"Add these lines (the QEMU job now depends on them):\n  %s\n"+
			"Remove these lines (no longer a dependency):\n  %s",
			gateFile, strings.Join(missing, "\n  "), strings.Join(stale, "\n  "))
	}
}
