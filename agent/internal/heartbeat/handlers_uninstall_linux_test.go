//go:build linux

package heartbeat

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func linuxIsolationScriptOptions(binary string) linuxUninstallScriptOptions {
	return linuxUninstallScriptOptions{
		ServiceName:     "breeze-agent",
		WatchdogService: "breeze-watchdog",
		WatchdogProcess: "breeze-watchdog",
		UnitPath:        "/etc/systemd/system/breeze-agent.service",
		BinaryPath:      binary,
		IsolationUnits:  []string{"/etc/systemd/system/breeze-isolation.service", "/etc/systemd/system/breeze-isolation-poll.timer"},
		RecoveryDir:     "/usr/local/lib/breeze/isolation-recovery",
		ConfigDir:       "/etc/breeze",
		RemoveConfig:    true,
		DelaySeconds:    5,
	}
}

func TestLinuxUninstallScriptReleasesBeforeAnyTeardown(t *testing.T) {
	script := buildLinuxUninstallScript(linuxIsolationScriptOptions("/usr/local/bin/breeze-agent"))
	release := strings.Index(script, "containment release-all --reason uninstall")
	if release < 0 {
		t.Fatalf("no release:\n%s", script)
	}
	for _, later := range []string{"systemctl stop", "systemctl disable", "pkill", "rm -f", "rm -rf", "daemon-reload", "sleep"} {
		if at := strings.Index(script, later); at >= 0 && at < release {
			t.Errorf("%q runs before the isolation release:\n%s", later, script)
		}
	}
	assertOrder(t, script,
		"rm -f '/etc/systemd/system/breeze-isolation.service'",
		"rm -f '/etc/systemd/system/breeze-isolation-poll.timer'",
		"systemctl daemon-reload",
		"rm -f '/usr/local/bin/breeze-agent'",
		"rm -rf '/usr/local/lib/breeze/isolation-recovery'",
		"rm -rf '/etc/breeze'",
	)
}

// writeShims replaces every mutating command with a logger. The tests run the
// real script text against them; nothing on the host changes.
func writeShims(t *testing.T, dir, logPath string, names map[string]int) {
	t.Helper()
	for name, exit := range names {
		body := "#!/bin/sh\necho \"" + name + " $*\" >> '" + logPath + "'\nexit " + string(rune('0'+exit)) + "\n"
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
}

func readLog(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(data)), "\n")
}

func TestLinuxUninstallScriptExecutionAbortsOnFailedRelease(t *testing.T) {
	for _, tc := range []struct {
		name        string
		releaseExit int
		wantFailure bool
	}{
		{"failed release", 1, true},
		{"confirmed release", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			logPath := filepath.Join(dir, "calls.log")
			writeShims(t, dir, logPath, map[string]int{"systemctl": 0, "pkill": 0, "rm": 0, "sleep": 0, "agent": tc.releaseExit})
			script := buildLinuxUninstallScript(linuxIsolationScriptOptions(filepath.Join(dir, "agent")))
			cmd := exec.Command("/bin/sh", "-c", script)
			cmd.Env = []string{"PATH=" + dir}
			out, err := cmd.CombinedOutput()
			if (err != nil) != tc.wantFailure {
				t.Fatalf("err = %v, output = %s", err, out)
			}
			calls := readLog(t, logPath)
			if len(calls) == 0 || !strings.HasPrefix(calls[0], "agent containment release-all") {
				t.Fatalf("release must run first: %v", calls)
			}
			joined := strings.Join(calls, "\n")
			torndown := strings.Contains(joined, "rm ") || strings.Contains(joined, "systemctl stop") || strings.Contains(joined, "pkill")
			if torndown == tc.wantFailure {
				t.Fatalf("teardown ran = %v with release exit %d:\n%s", torndown, tc.releaseExit, joined)
			}
			// Phase 1 disabled the service, and the handler's shutdown goroutine
			// will exit the agent cleanly (Restart=on-failure does not restart
			// that). A failed release must re-enable AND restart it, after the
			// result has had time to go out, or the host is left isolated with
			// no agent running.
			if enabled := strings.Contains(joined, "systemctl enable breeze-agent"); enabled != tc.wantFailure {
				t.Fatalf("re-enable = %v:\n%s", enabled, joined)
			}
			restart := indexOfCall(calls, "systemctl restart breeze-agent")
			if (restart >= 0) != tc.wantFailure {
				t.Fatalf("restart = %v:\n%s", restart >= 0, joined)
			}
			if tc.wantFailure && (indexOfCall(calls, "sleep 5") < 0 || indexOfCall(calls, "sleep 5") > restart || indexOfCall(calls, "systemctl enable") > restart) {
				t.Fatalf("abort must enable, wait for the result, then restart:\n%s", joined)
			}
			if tc.wantFailure && !strings.Contains(string(out), "isolation release could not be confirmed") {
				t.Fatalf("no reason given: %s", out)
			}
		})
	}
}

// Both copies of uninstall.sh must run the same release, so they are executed,
// not grepped: everything before the entrypoint is sourced, then the paths are
// repointed at shims.
// uninstallEnv describes the host the uninstall script sees.
type uninstallEnv struct {
	journal bool   // an isolation journal exists in the data directory
	nftOut  string // `nft list tables` output
	nftExit int
}

func runUninstallLinux(t *testing.T, script string, shims map[string]int, recoveryExit int) (string, []string, error) {
	t.Helper()
	env := uninstallEnv{nftExit: shims["nft"]}
	if shims["nft"] == 0 {
		env.nftOut = "table inet breeze_isolation"
	}
	delete(shims, "nft")
	return runUninstallLinuxEnv(t, script, shims, recoveryExit, env)
}

func runUninstallLinuxEnv(t *testing.T, script string, shims map[string]int, recoveryExit int, env uninstallEnv) (string, []string, error) {
	t.Helper()
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not available")
	}
	data, err := os.ReadFile(script)
	if err != nil {
		t.Fatal(err)
	}
	head, _, found := strings.Cut(string(data), "\nrequire_root\n")
	if !found {
		t.Fatalf("%s has no entrypoint marker", script)
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	writeShims(t, dir, logPath, shims)
	nft := "#!/bin/sh\necho \"nft $*\" >> '" + logPath + "'\n[ -n \"$NFT_OUT\" ] && echo \"$NFT_OUT\"\nexit \"$NFT_EXIT\"\n"
	if err := os.WriteFile(filepath.Join(dir, "nft"), []byte(nft), 0o755); err != nil {
		t.Fatal(err)
	}
	dataDir := filepath.Join(dir, "data")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if env.journal {
		if err := os.WriteFile(filepath.Join(dataDir, "isolation.json"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	root := filepath.Join(dir, "lib")
	if recoveryExit >= 0 {
		versionDir := filepath.Join(root, "isolation-recovery", "1.2.3")
		if err := os.MkdirAll(versionDir, 0o755); err != nil {
			t.Fatal(err)
		}
		body := "#!/bin/sh\necho \"recovery $*\" >> '" + logPath + "'\nexit " + string(rune('0'+recoveryExit)) + "\n"
		if err := os.WriteFile(filepath.Join(versionDir, "breeze-isolation-recovery"), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	program := head + "\nAGENT_BINARY=" + shQuote(filepath.Join(dir, "agent")) +
		"\nWATCHDOG_BINARY=/nonexistent/w\nBACKUP_BINARY=/nonexistent/b\nISOLATION_RECOVERY_ROOT=" + shQuote(root) +
		"\nISOLATION_DATA_DIR=" + shQuote(dataDir) +
		"\nuninstall_linux\n"
	cmd := exec.Command(bash, "-c", program)
	cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "NFT_OUT=" + env.nftOut, "NFT_EXIT=" + string(rune('0'+env.nftExit))}
	out, runErr := cmd.CombinedOutput()
	return string(out), readLog(t, logPath), runErr
}

func indexOfCall(calls []string, prefix string) int {
	for n, call := range calls {
		if strings.HasPrefix(call, prefix) {
			return n
		}
	}
	return -1
}

func TestUninstallScriptsReleaseIsolationFirst(t *testing.T) {
	for _, script := range []string{"../../scripts/install/uninstall.sh", "../../../apps/web/public/scripts/uninstall.sh"} {
		t.Run(filepath.Base(filepath.Dir(script))+"/"+filepath.Base(script), func(t *testing.T) {
			teardown := func(calls []string) bool {
				joined := strings.Join(calls, "\n")
				return strings.Contains(joined, "rm ") || strings.Contains(joined, "systemctl disable") || strings.Contains(joined, "systemctl stop breeze-agent")
			}
			base := func(nft, agent int) map[string]int {
				return map[string]int{"systemctl": 0, "rm": 0, "rmdir": 0, "nft": nft, "agent": agent}
			}

			t.Run("never isolated proceeds without a release", func(t *testing.T) {
				out, calls, err := runUninstallLinux(t, script, base(1, 0), -1)
				if err != nil {
					t.Fatalf("%v: %s", err, out)
				}
				if indexOfCall(calls, "agent ") >= 0 {
					t.Fatalf("an old agent may not know this command: %v", calls)
				}
				if !teardown(calls) {
					t.Fatalf("no teardown: %v", calls)
				}
			})
			t.Run("rules present, release confirmed", func(t *testing.T) {
				out, calls, err := runUninstallLinux(t, script, base(0, 0), -1)
				if err != nil {
					t.Fatalf("%v: %s", err, out)
				}
				release := indexOfCall(calls, "agent containment release-all --reason uninstall")
				if release < 0 {
					t.Fatalf("no release: %v", calls)
				}
				for _, later := range []string{"rm ", "systemctl disable", "systemctl stop"} {
					if at := indexOfCall(calls, later); at >= 0 && at < release {
						t.Errorf("%q ran before the release: %v", later, calls)
					}
				}
				joined := strings.Join(calls, "\n")
				for _, want := range []string{"breeze-isolation.service", "breeze-isolation-poll.timer", "isolation-recovery"} {
					if !strings.Contains(joined, want) {
						t.Errorf("%s not cleaned up: %v", want, calls)
					}
				}
			})
			t.Run("release fails, nothing removed", func(t *testing.T) {
				out, calls, err := runUninstallLinux(t, script, base(0, 1), -1)
				if err == nil {
					t.Fatalf("the uninstall must abort: %s", out)
				}
				if teardown(calls) {
					t.Fatalf("teardown ran after a failed release: %v", calls)
				}
				if !regexp.MustCompile(`could not be released; nothing was removed`).MatchString(out) {
					t.Fatalf("no reason given: %s", out)
				}
			})
			t.Run("a broken agent falls back to the recovery binary", func(t *testing.T) {
				out, calls, err := runUninstallLinux(t, script, base(0, 1), 0)
				if err != nil {
					t.Fatalf("%v: %s", err, out)
				}
				if at := indexOfCall(calls, "recovery "); at < 0 || !strings.HasPrefix(calls[at], "recovery release-all --data-dir ") || !strings.HasSuffix(calls[at], "/data --reason uninstall") {
					t.Fatalf("calls = %v", calls)
				}
				if !teardown(calls) {
					t.Fatalf("no teardown after the recovery release: %v", calls)
				}
			})
			// A failed listing is not an observed absence.
			t.Run("journal present, nft errors, nothing can release", func(t *testing.T) {
				out, calls, err := runUninstallLinuxEnv(t, script, map[string]int{"systemctl": 0, "rm": 0, "rmdir": 0, "agent": 1}, -1,
					uninstallEnv{journal: true, nftExit: 1})
				if err == nil {
					t.Fatalf("an unreadable engine must not count as no rules: %s", out)
				}
				if teardown(calls) {
					t.Fatalf("teardown ran: %v", calls)
				}
			})
			t.Run("journal present, rules observably gone, nothing can release", func(t *testing.T) {
				out, calls, err := runUninstallLinuxEnv(t, script, map[string]int{"systemctl": 0, "rm": 0, "rmdir": 0, "agent": 1}, -1,
					uninstallEnv{journal: true, nftOut: "table ip filter"})
				if err != nil {
					t.Fatalf("a half-removed install with no rules must uninstall: %v %s", err, out)
				}
				if !teardown(calls) {
					t.Fatalf("no teardown: %v", calls)
				}
			})
			// No journal and an engine that cannot be asked: never isolated by
			// any Breeze build that journals, so the uninstall must not be stuck
			// (a host whose kernel lacks nf_tables cannot run `nft list`).
			t.Run("no journal, nft errors", func(t *testing.T) {
				out, calls, err := runUninstallLinuxEnv(t, script, map[string]int{"systemctl": 0, "rm": 0, "rmdir": 0, "agent": 1}, -1,
					uninstallEnv{nftExit: 1})
				if err != nil {
					t.Fatalf("%v: %s", err, out)
				}
				if !teardown(calls) {
					t.Fatalf("no teardown: %v", calls)
				}
			})
			t.Run("agent and recovery both fail", func(t *testing.T) {
				out, calls, err := runUninstallLinux(t, script, base(0, 1), 1)
				if err == nil {
					t.Fatalf("the uninstall must abort: %s", out)
				}
				if teardown(calls) {
					t.Fatalf("teardown ran: %v", calls)
				}
			})
		})
	}
}
