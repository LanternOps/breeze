package installer

// install-darwin.sh runs under `set -euo pipefail`. Its breeze_group_has_member
// used to pipe the dscl member list into `grep -qx`: grep exits at the first
// match, the rest of a long list hits a closed pipe, and pipefail reports the
// SIGPIPE as "not a member" (the #7960 pattern). The install then appends a
// duplicate GroupMembership entry and can print a false warning. This runs the
// real function under bash with dscl stubbed on PATH.

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var breezeGroupHasMemberFunc = regexp.MustCompile(`(?ms)^breeze_group_has_member\(\) \{\n.*?^\}\n`)

func TestInstallDarwinBreezeGroupHasMemberSurvivesEarlyMatch(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash not available")
	}
	fn := breezeGroupHasMemberFunc.FindString(readRepoFile(t, "../scripts/install/install-darwin.sh"))
	if fn == "" {
		t.Fatal("could not find breeze_group_has_member in install-darwin.sh")
	}

	// The stub prints `GroupMembership: early <filler...> late` on one line,
	// with far more filler than a pipe buffer holds, or fails like dscl does
	// when the group has no GroupMembership key.
	bin := t.TempDir()
	stub := "#!/bin/sh\n" +
		"[ \"$DSCL_FAIL\" = 1 ] && exit 56\n" +
		"printf 'GroupMembership: early '\n" +
		"yes filler | head -n 200000 | tr '\\n' ' '\n" +
		"printf 'late\\n'\n"
	if err := os.WriteFile(filepath.Join(bin, "dscl"), []byte(stub), 0o755); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		user, fail, want string
	}{
		{user: "early", want: "member"},
		{user: "late", want: "member"},
		{user: "absent", want: "not-member"},
		{user: "early", fail: "1", want: "not-member"},
	} {
		t.Run(tc.user+"/fail="+tc.fail, func(t *testing.T) {
			script := "set -euo pipefail\n" + fn +
				"if breeze_group_has_member \"$1\"; then echo member; else echo not-member; fi\n"
			// Several runs: the old pipe only fails when grep wins the race.
			for i := 0; i < 5; i++ {
				cmd := exec.Command("bash", "-c", script, "bash", tc.user)
				cmd.Env = append(os.Environ(), "PATH="+bin+string(os.PathListSeparator)+os.Getenv("PATH"), "DSCL_FAIL="+tc.fail)
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("run %d: %v\n%s", i, err, out)
				}
				if got := strings.TrimSpace(string(out)); got != tc.want {
					t.Fatalf("run %d: breeze_group_has_member %s = %q, want %q", i, tc.user, got, tc.want)
				}
			}
		})
	}
}
