package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"strings"
	"testing"
)

const testInstallerURL = "https://raw.githubusercontent.com/Homebrew/install/cced90146ea6d3057c03a636b668fef177415eb3/install.sh"

// sha256 of the literal string "#!/bin/bash\necho hi\n" used by the fake
// downloads below; computed once here so the tests never hard-code a hash that
// drifts from the body.
func testScriptBody() []byte { return []byte("#!/bin/bash\necho hi\n") }

func testScriptSha() string { return computeSHA256Bytes(testScriptBody()) }

func testConsoleUser() *user.User {
	return &user.User{Username: "alice", HomeDir: os.TempDir()}
}

// bootstrapTestDeps returns deps that succeed end-to-end; individual tests
// override the one seam they care about.
func bootstrapTestDeps() (bootstrapDeps, *bootstrapCallLog) {
	log := &bootstrapCallLog{}
	deps := bootstrapDeps{
		goos: "darwin",
		download: func(url string) ([]byte, error) {
			log.downloads++
			log.downloadURL = url
			return testScriptBody(), nil
		},
		brewPath: func() (string, error) {
			log.brewPathCalls++
			if log.brewPathCalls == 1 && !log.brewPresentInitially {
				return "", fmt.Errorf("brew binary not found")
			}
			return "/opt/homebrew/bin/brew", nil
		},
		consoleUser: func() (*user.User, error) { return testConsoleUser(), nil },
		runScript: func(scriptPath string, u *user.User) (string, int, error) {
			log.ran++
			log.ranPath = scriptPath
			log.ranUser = u.Username
			return "installed", 0, nil
		},
	}
	return deps, log
}

type bootstrapCallLog struct {
	downloads            int
	downloadURL          string
	brewPathCalls        int
	brewPresentInitially bool
	ran                  int
	ranPath              string
	ranUser              string
}

func decodeBootstrapResult(t *testing.T, res CommandResult) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("stdout is not JSON: %v (%q)", err, res.Stdout)
	}
	return out
}

func TestBootstrapHomebrewRequiresChecksum(t *testing.T) {
	deps, log := bootstrapTestDeps()
	res := bootstrapHomebrew(map[string]any{"installerUrl": testInstallerURL}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "installerSha256") {
		t.Fatalf("error = %q, want mention of installerSha256", res.Error)
	}
	if log.downloads != 0 || log.ran != 0 {
		t.Fatalf("nothing should have been downloaded or executed: %+v", log)
	}
}

func TestBootstrapHomebrewRejectsMalformedChecksum(t *testing.T) {
	deps, log := bootstrapTestDeps()
	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": "not-a-sha",
	}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if log.downloads != 0 || log.ran != 0 {
		t.Fatalf("nothing should have been downloaded or executed: %+v", log)
	}
}

func TestBootstrapHomebrewRejectsUnpinnedOrForeignURL(t *testing.T) {
	cases := []string{
		"https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh",
		"https://raw.githubusercontent.com/Homebrew/install/master/install.sh",
		"https://example.com/install.sh",
		"http://raw.githubusercontent.com/Homebrew/install/cced90146ea6d3057c03a636b668fef177415eb3/install.sh",
		"https://raw.githubusercontent.com/Evil/install/cced90146ea6d3057c03a636b668fef177415eb3/install.sh",
	}
	for _, url := range cases {
		deps, log := bootstrapTestDeps()
		res := bootstrapHomebrew(map[string]any{
			"installerUrl":    url,
			"installerSha256": testScriptSha(),
		}, deps)
		if res.Status != "failed" {
			t.Fatalf("url %q: status = %q, want failed", url, res.Status)
		}
		if log.downloads != 0 || log.ran != 0 {
			t.Fatalf("url %q: nothing should have been downloaded or executed: %+v", url, log)
		}
	}
}

func TestBootstrapHomebrewChecksumMismatchNeverExecutes(t *testing.T) {
	deps, log := bootstrapTestDeps()
	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": strings.Repeat("a", 64),
	}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "checksum mismatch") {
		t.Fatalf("error = %q, want checksum mismatch", res.Error)
	}
	if log.downloads != 1 {
		t.Fatalf("downloads = %d, want 1", log.downloads)
	}
	if log.ran != 0 {
		t.Fatal("installer must never execute after a checksum mismatch")
	}
}

func TestBootstrapHomebrewAlreadyInstalledShortCircuits(t *testing.T) {
	deps, log := bootstrapTestDeps()
	log.brewPresentInitially = true

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "completed" {
		t.Fatalf("status = %q (%s), want completed", res.Status, res.Error)
	}
	out := decodeBootstrapResult(t, res)
	if out["alreadyInstalled"] != true {
		t.Fatalf("alreadyInstalled = %v, want true", out["alreadyInstalled"])
	}
	if out["brewPath"] != "/opt/homebrew/bin/brew" {
		t.Fatalf("brewPath = %v", out["brewPath"])
	}
	if log.downloads != 0 || log.ran != 0 {
		t.Fatalf("an already-installed brew must not download or execute anything: %+v", log)
	}
}

func TestBootstrapHomebrewRequiresConsoleUser(t *testing.T) {
	deps, log := bootstrapTestDeps()
	deps.consoleUser = func() (*user.User, error) {
		return nil, fmt.Errorf("no active non-root console user")
	}

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "no active non-root console user") {
		t.Fatalf("error = %q, want console-user explanation", res.Error)
	}
	if log.downloads != 0 || log.ran != 0 {
		t.Fatalf("nothing should run without a console user: %+v", log)
	}
}

func TestBootstrapHomebrewSuccess(t *testing.T) {
	deps, log := bootstrapTestDeps()

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "completed" {
		t.Fatalf("status = %q (%s), want completed", res.Status, res.Error)
	}
	out := decodeBootstrapResult(t, res)
	if out["alreadyInstalled"] != false {
		t.Fatalf("alreadyInstalled = %v, want false", out["alreadyInstalled"])
	}
	if out["brewPath"] != "/opt/homebrew/bin/brew" {
		t.Fatalf("brewPath = %v, want the post-install resolved path", out["brewPath"])
	}
	if out["consoleUser"] != "alice" {
		t.Fatalf("consoleUser = %v", out["consoleUser"])
	}
	if log.ran != 1 {
		t.Fatalf("ran = %d, want 1", log.ran)
	}
	if log.ranUser != "alice" {
		t.Fatalf("ranUser = %q", log.ranUser)
	}
	// The verified script must be gone once the command returns.
	if _, err := os.Stat(log.ranPath); err == nil {
		t.Fatalf("temp installer %q was not cleaned up", log.ranPath)
	}
	if res.StartedAt == "" {
		t.Fatal("StartedAt must be stamped")
	}
}

func TestBootstrapHomebrewInstallerFailureIsReported(t *testing.T) {
	deps, _ := bootstrapTestDeps()
	deps.runScript = func(string, *user.User) (string, int, error) {
		return "boom", 1, fmt.Errorf("exit status 1")
	}

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if res.ExitCode != 1 {
		t.Fatalf("exitCode = %d, want 1", res.ExitCode)
	}
	if !strings.Contains(res.Stdout, "boom") {
		t.Fatalf("stdout = %q, want installer output", res.Stdout)
	}
}

func TestBootstrapHomebrewFailsWhenBrewStillMissingAfterInstall(t *testing.T) {
	deps, _ := bootstrapTestDeps()
	deps.brewPath = func() (string, error) { return "", fmt.Errorf("brew binary not found") }

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "brew binary not found") {
		t.Fatalf("error = %q", res.Error)
	}
}

func TestBootstrapHomebrewIsDarwinOnly(t *testing.T) {
	deps, log := bootstrapTestDeps()
	deps.goos = "windows"

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "macOS") {
		t.Fatalf("error = %q, want a macOS-only explanation", res.Error)
	}
	if log.downloads != 0 || log.ran != 0 {
		t.Fatalf("nothing should run off darwin: %+v", log)
	}
}

func TestBootstrapHomebrewTruncatesInstallerOutput(t *testing.T) {
	deps, _ := bootstrapTestDeps()
	deps.runScript = func(string, *user.User) (string, int, error) {
		return strings.Repeat("x", maxInstallerOutputBytes+4096), 0, nil
	}

	res := bootstrapHomebrew(map[string]any{
		"installerUrl":    testInstallerURL,
		"installerSha256": testScriptSha(),
	}, deps)

	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	out := decodeBootstrapResult(t, res)
	output, _ := out["output"].(string)
	if len(output) > maxInstallerOutputBytes+64 {
		t.Fatalf("output length = %d, want truncated to ~%d", len(output), maxInstallerOutputBytes)
	}
	if out["outputTruncated"] != true {
		t.Fatalf("outputTruncated = %v, want true", out["outputTruncated"])
	}
}
