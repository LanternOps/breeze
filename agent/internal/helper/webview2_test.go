package helper

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// #10183: a stock Windows 11 21H2 image ships WebView2 90.0.818.66.
const inboxWin11WebView2 = "90.0.818.66"

func TestParseWebView2Version(t *testing.T) {
	good := map[string]webview2Version{
		"90.0.818.66":     {90, 0, 818, 66},
		"120.0.2210.91":   {120, 0, 2210, 91},
		" 92.0.902.49 \n": {92, 0, 902, 49},
	}
	for in, want := range good {
		got, ok := parseWebView2Version(in)
		if !ok || got != want {
			t.Fatalf("parseWebView2Version(%q) = %v, %v; want %v, true", in, got, ok, want)
		}
	}
	for _, in := range []string{"", "0.0.0.0", "abc", "1.2.3", "1.2.3.4.5", "1.2.x.4", "-1.0.0.0", "1..2.3", "99999999999.0.0.0", "+1.0.0.0"} {
		if v, ok := parseWebView2Version(in); ok {
			t.Fatalf("parseWebView2Version(%q) = %v, true; want rejected", in, v)
		}
	}
}

func TestWebView2Less(t *testing.T) {
	v := func(s string) webview2Version {
		t.Helper()
		out, ok := parseWebView2Version(s)
		if !ok {
			t.Fatalf("bad fixture %q", s)
		}
		return out
	}
	cases := []struct {
		a, b string
		less bool
	}{
		{"90.0.818.66", "120.0.2210.91", true},
		{"120.0.2210.91", "90.0.818.66", false},
		{"92.0.902.49", "92.0.902.49", false},
		{"92.0.902.49", "92.0.902.50", true},
		{"99.9.9.9", "100.0.0.0", true}, // numeric, not lexical
	}
	for _, tc := range cases {
		if got := v(tc.a).less(v(tc.b)); got != tc.less {
			t.Fatalf("%s < %s = %v, want %v", tc.a, tc.b, got, tc.less)
		}
	}
}

// The compiled fallback must itself parse, and must refuse the runtime from
// #10183 — otherwise the gate is a no-op on exactly the device that motivated it.
func TestFallbackMinWebView2RefusesTheInboxRuntime(t *testing.T) {
	min, ok := parseWebView2Version(fallbackMinWebView2)
	if !ok {
		t.Fatalf("fallbackMinWebView2 %q does not parse", fallbackMinWebView2)
	}
	inbox, _ := parseWebView2Version(inboxWin11WebView2)
	if !inbox.less(min) {
		t.Fatalf("inbox runtime %s is not below the fallback minimum %s", inboxWin11WebView2, fallbackMinWebView2)
	}
	if fallbackAssistRequirements.MinWebView2Version != fallbackMinWebView2 {
		t.Fatalf("fallbackAssistRequirements min = %q, want %q", fallbackAssistRequirements.MinWebView2Version, fallbackMinWebView2)
	}
}

func writeSidecar(t *testing.T, dir, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, assistRequirementsFile), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadAssistRequirementsUsesAMatchingSidecar(t *testing.T) {
	dir := t.TempDir()
	writeSidecar(t, dir, `{"assistVersion":"0.125.0","minWebView2Version":"110.0.1587.41"}`)
	for _, installed := range []string{"0.125.0", "v0.125.0"} {
		got := loadAssistRequirements(dir, installed)
		if got.MinWebView2Version != "110.0.1587.41" || got.AssistVersion != "0.125.0" {
			t.Fatalf("installed %q: got %+v, want the sidecar values", installed, got)
		}
	}
}

// P12: an update rollback restores only the executable, so a sidecar left by
// the newer build must not set the bar for the older one.
func TestLoadAssistRequirementsMismatchedVersionUsesFallback(t *testing.T) {
	dir := t.TempDir()
	writeSidecar(t, dir, `{"assistVersion":"0.2.0","minWebView2Version":"150.0.1.1"}`)
	if got := loadAssistRequirements(dir, "0.1.9"); got != fallbackAssistRequirements {
		t.Fatalf("got %+v, want the fallback", got)
	}
}

func TestLoadAssistRequirementsMissingUsesFallback(t *testing.T) {
	if got := loadAssistRequirements(t.TempDir(), "0.125.0"); got != fallbackAssistRequirements {
		t.Fatalf("got %+v, want the fallback", got)
	}
}

func TestLoadAssistRequirementsMalformedUsesFallback(t *testing.T) {
	cases := map[string]string{
		"not json":             `{"assistVersion":`,
		"bad minimum":          `{"assistVersion":"0.125.0","minWebView2Version":"1.2.3"}`,
		"zero minimum":         `{"assistVersion":"0.125.0","minWebView2Version":"0.0.0.0"}`,
		"no assist version":    `{"minWebView2Version":"110.0.1587.41"}`,
		"oversized":            `{"assistVersion":"0.125.0","minWebView2Version":"110.0.1587.41","pad":"` + strings.Repeat("x", 8192) + `"}`,
		"unreadable installed": `{"assistVersion":"0.125.0","minWebView2Version":"110.0.1587.41"}`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			writeSidecar(t, dir, body)
			installed := "0.125.0"
			if name == "unreadable installed" {
				installed = ""
			}
			if got := loadAssistRequirements(dir, installed); got != fallbackAssistRequirements {
				t.Fatalf("got %+v, want the fallback", got)
			}
		})
	}
}

// newWebView2GateManager is an installed, enabled Assist on a host where the
// gate applies, with a WebView2 reader the test controls.
func newWebView2GateManager(t *testing.T, found *string) (*Manager, *int) {
	t.Helper()
	mgr, spawns := newNotInstalledManager(t)
	t.Cleanup(mgr.Shutdown)
	if err := os.WriteFile(mgr.binaryPath, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	orig := webview2GateApplies
	t.Cleanup(func() { webview2GateApplies = orig })
	webview2GateApplies = true
	mgr.readWebView2Func = func(string) (string, bool) {
		if *found == "" {
			return "", false
		}
		return *found, true
	}
	return mgr, spawns
}

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	logging.Init("text", "debug", &buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return &buf
}

func TestEnsureRunningRefusesBelowMinimum(t *testing.T) {
	buf := captureLogs(t)
	found := inboxWin11WebView2
	mgr, spawns := newWebView2GateManager(t, &found)

	mgr.Apply(&Settings{Enabled: true})
	mgr.Apply(&Settings{Enabled: true})

	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times below the WebView2 minimum, want 0", *spawns)
	}
	if got := mgr.InstallIssue(); got != InstallIssueWebView2Outdated {
		t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueWebView2Outdated)
	}
	if w := mgr.sessions["1"].watcher; w != nil {
		t.Fatal("a refused launch must not start a watcher (it would count crashes)")
	}
	var refusals []string
	for _, line := range strings.Split(buf.String(), "\n") {
		if strings.Contains(line, "WebView2 runtime is older than") {
			refusals = append(refusals, line)
		}
	}
	if len(refusals) != 1 {
		t.Fatalf("refusal logged %d times over two heartbeats, want once:\n%s", len(refusals), buf.String())
	}
	for _, want := range []string{"level=WARN", "found=" + inboxWin11WebView2, "minimum=" + fallbackMinWebView2} {
		if !strings.Contains(refusals[0], want) {
			t.Fatalf("refusal line missing %q: %s", want, refusals[0])
		}
	}
	if strings.Contains(buf.String(), "failed to start breeze assist") {
		t.Fatalf("a refused launch is reported once by the gate, not as a start ERROR every heartbeat:\n%s", buf.String())
	}
}

// Control for the refusal: a current runtime launches. Without it the test
// above could pass against a gate that refuses everything.
func TestEnsureRunningLaunchesAtOrAboveMinimum(t *testing.T) {
	for _, v := range []string{fallbackMinWebView2, "156.0.3800.12"} {
		found := v
		mgr, spawns := newWebView2GateManager(t, &found)
		mgr.Apply(&Settings{Enabled: true})
		if *spawns != 1 {
			t.Fatalf("WebView2 %s: spawnFunc called %d times, want 1", v, *spawns)
		}
		if got := mgr.InstallIssue(); got != "" {
			t.Fatalf("WebView2 %s: InstallIssue() = %q, want empty", v, got)
		}
	}
}

// A version the registry does not show is not evidence of an old runtime
// (fixed-version installs, unusual layouts): fail open to today's behaviour.
func TestEnsureRunningLaunchesWhenWebView2VersionUnknown(t *testing.T) {
	found := ""
	mgr, spawns := newWebView2GateManager(t, &found)
	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times with the WebView2 version unknown, want 1", *spawns)
	}
}

func TestEnsureRunningUsesTheSidecarMinimum(t *testing.T) {
	found := "120.0.2210.91"
	mgr, spawns := newWebView2GateManager(t, &found)
	mgr.binaryVersionFunc = func(string) (string, error) { return "0.125.0", nil }
	writeSidecar(t, filepath.Dir(mgr.binaryPath), `{"assistVersion":"0.125.0","minWebView2Version":"130.0.2849.39"}`)

	mgr.Apply(&Settings{Enabled: true})

	if *spawns != 0 {
		t.Fatalf("spawnFunc called %d times below the sidecar minimum, want 0", *spawns)
	}
	if got := mgr.InstallIssue(); got != InstallIssueWebView2Outdated {
		t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueWebView2Outdated)
	}
}

func TestWebView2UpdateClearsTheRefusal(t *testing.T) {
	found := inboxWin11WebView2
	mgr, spawns := newWebView2GateManager(t, &found)
	mgr.Apply(&Settings{Enabled: true})
	if got := mgr.InstallIssue(); got != InstallIssueWebView2Outdated {
		t.Fatalf("InstallIssue() = %q, want %q", got, InstallIssueWebView2Outdated)
	}

	found = "156.0.3800.12" // the user (or Edge Update) installed a current runtime
	mgr.Apply(&Settings{Enabled: true})

	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times after the runtime update, want 1", *spawns)
	}
	if got := mgr.InstallIssue(); got != "" {
		t.Fatalf("InstallIssue() after the runtime update = %q, want empty", got)
	}
}

func TestWebView2GateSkippedOffWindows(t *testing.T) {
	found := inboxWin11WebView2
	mgr, spawns := newWebView2GateManager(t, &found)
	webview2GateApplies = false
	mgr.Apply(&Settings{Enabled: true})
	if *spawns != 1 {
		t.Fatalf("spawnFunc called %d times where the gate does not apply, want 1", *spawns)
	}
}

// The badge must not report a refusal once the policy turns Assist off.
func TestWebView2IssueNotReportedWhileDisabled(t *testing.T) {
	found := inboxWin11WebView2
	mgr, _ := newWebView2GateManager(t, &found)
	stubUninstall(t, mgr.binaryPath)
	markAgentInstalled(t, mgr)
	mgr.Apply(&Settings{Enabled: true})
	mgr.Apply(&Settings{Enabled: false})
	if got := mgr.InstallIssue(); got != "" {
		t.Fatalf("InstallIssue() with Assist disabled = %q, want empty", got)
	}
}
