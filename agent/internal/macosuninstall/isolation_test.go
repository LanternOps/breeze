//go:build !windows

package macosuninstall

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const isolationDataDir = "/Library/Application Support/Breeze/data"

// isolationFixture rewrites the isolation paths into a temporary root and puts a
// fake agent and recovery binary there, so the release step runs end to end
// without touching this host. Every other command is the shared teardown shim.
func isolationFixture(t *testing.T, journal bool, agentExit, recoveryExit string) (script, root string) {
	t.Helper()
	if _, err := os.Stat("/usr/bin/python3"); err != nil {
		t.Skip("python3 not available")
	}
	root = t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	writeTeardownShims(t, bin)
	if journal {
		if err := os.MkdirAll(root+isolationDataDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(root+isolationDataDir+"/isolation.json", []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	fake := func(path, name, exit string) {
		if exit == "" {
			return
		}
		if err := os.MkdirAll(filepath.Dir(root+path), 0o700); err != nil {
			t.Fatal(err)
		}
		body := "#!/bin/sh\necho \"" + name + " $*\" >> \"$FIXTURE_ROOT/calls\"\nexit " + exit + "\n"
		if err := os.WriteFile(root+path, []byte(body), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	fake("/Library/Breeze/bin/breeze-agent", "agent", agentExit)
	fake("/Library/Breeze/isolation-recovery/1.2.3/breeze-isolation-recovery", "recovery", recoveryExit)
	script = strings.NewReplacer(
		isolationDataDir, root+isolationDataDir,
		"in /Library/Breeze/bin/breeze-agent /usr/local/bin/breeze-agent;", "in "+root+"/Library/Breeze/bin/breeze-agent "+root+"/usr/local/bin/breeze-agent;",
		"in /Library/Breeze/isolation-recovery/*/", "in "+root+"/Library/Breeze/isolation-recovery/*/",
	).Replace(Script())
	// Every occurrence must now sit under the fixture root.
	for _, path := range []string{isolationDataDir, "/Library/Breeze/bin/breeze-agent /usr", "/Library/Breeze/isolation-recovery/*/"} {
		if strings.Count(script, path) != strings.Count(script, root+path) {
			t.Fatalf("fixture left a real path in the script: %s", path)
		}
	}
	return script, root
}

// runIsolationScript returns the recorded command calls and the script's output.
func runIsolationScript(t *testing.T, script, root string) (string, string, error) {
	t.Helper()
	cmd := exec.Command("/bin/bash", "-o", "pipefail", "-c", script)
	cmd.Env = append(os.Environ(), "PATH="+root+"/bin:/usr/bin:/bin", "FIXTURE_ROOT="+root, "FAIL_COMMAND=")
	out, err := cmd.CombinedOutput()
	calls, _ := os.ReadFile(filepath.Join(root, "calls"))
	return string(calls), string(out), err
}

// Spec §3.6 item 4: uninstall releases isolation BEFORE anything else stops.
// A Mac whose rules cannot be confirmed gone keeps its agent and its recovery
// jobs, so the episode can still expire or be released.
func TestScriptReleasesIsolationBeforeAnyBreezeDaemonStops(t *testing.T) {
	for _, tc := range []struct {
		name            string
		journal         bool
		agent, recovery string
		wantFirst       string
		wantFail        bool
	}{
		{name: "never isolated: nothing to release", journal: false, agent: "0"},
		{name: "the agent releases", journal: true, agent: "0", wantFirst: "agent containment release-all --reason uninstall"},
		{name: "a broken agent: the recovery binary releases", journal: true, agent: "1", recovery: "0", wantFirst: "recovery release-all --data-dir"},
		{name: "no agent at all: the recovery binary releases", journal: true, recovery: "0", wantFirst: "recovery release-all"},
		{name: "nothing can confirm the release", journal: true, agent: "1", recovery: "1", wantFail: true},
		{name: "no tool at all", journal: true, wantFail: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			script, root := isolationFixture(t, tc.journal, tc.agent, tc.recovery)
			log, out, err := runIsolationScript(t, script, root)
			if (err != nil) != tc.wantFail {
				t.Fatalf("err=%v\n%s\n%s", err, log, out)
			}
			firstBootout := strings.Index(log, "launchctl bootout")
			if tc.wantFail {
				if firstBootout >= 0 || strings.Contains(log, "rm ") {
					t.Fatalf("an unconfirmed release must stop the uninstall before anything is removed:\n%s", log)
				}
				if !strings.Contains(out, "could not confirm") {
					t.Fatalf("the operator must be told why:\n%s", out)
				}
				return
			}
			if !tc.journal && (strings.Contains(log, "agent containment") || strings.Contains(log, "recovery release-all")) {
				t.Fatalf("ran a release with no journal (an older agent has no release-all):\n%s", log)
			}
			if tc.wantFirst != "" {
				release := strings.Index(log, tc.wantFirst)
				if release < 0 || firstBootout < release {
					t.Fatalf("want %q before any bootout:\n%s", tc.wantFirst, log)
				}
			}
		})
	}
}

func TestScriptRemovesIsolationJobsBeforeTheAgent(t *testing.T) {
	script, root := isolationFixture(t, false, "0", "")
	log, out, err := runIsolationScript(t, script, root)
	if err != nil {
		t.Fatalf("%v\n%s\n%s", err, log, out)
	}
	agent := strings.Index(log, "launchctl bootout system/com.breeze.agent\n")
	for _, want := range []string{
		"launchctl bootout system/com.breeze.isolation.rollback",
		"launchctl bootout system/com.breeze.isolation.expire",
		"launchctl bootout system/com.breeze.isolation\n",
		"rm -f /Library/LaunchDaemons/com.breeze.isolation.rollback.plist /Library/LaunchDaemons/com.breeze.isolation.expire.plist /Library/LaunchDaemons/com.breeze.isolation.plist",
		"rm -rf /Library/Breeze/isolation-recovery",
	} {
		i := strings.Index(log, want)
		if i < 0 || agent < i {
			t.Errorf("want %q before the agent stops:\n%s", want, log)
		}
	}
}

// The release step lives in the agent's own uninstall paths. The distributed
// download script moves in lockstep with apps/web, so it keeps only the shared
// functions; it must never call an isolation function it does not carry.
func TestDistributedScriptsDoNotCallIsolationFunctionsTheyLack(t *testing.T) {
	for _, p := range []string{"../../scripts/install/uninstall.sh", "../../../apps/web/public/scripts/uninstall.sh"} {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		calls := strings.Contains(string(b), "breeze_release_isolation") || strings.Contains(string(b), "breeze_remove_isolation")
		if calls && !strings.Contains(string(b), IsolationFunctions) {
			t.Errorf("%s calls the isolation functions without carrying them", p)
		}
	}
}
