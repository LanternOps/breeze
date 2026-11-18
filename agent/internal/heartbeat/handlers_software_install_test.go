package heartbeat

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// TestHandleSoftwareInstall_WiresCommandIDToWebSocketProgress proves the
// handler itself hands the install a reporter bound to THIS command's id and
// the heartbeat's WebSocket client — the one line every other test here goes
// around. Not parallel: it swaps package-level seams.
func TestHandleSoftwareInstall_WiresCommandIDToWebSocketProgress(t *testing.T) {
	origInstall, origSend := installSoftwareWithOptions, sendCommandProgress
	t.Cleanup(func() { installSoftwareWithOptions, sendCommandProgress = origInstall, origSend })

	ws := websocket.New(&websocket.Config{ServerURL: "http://127.0.0.1:0"}, nil)
	h := &Heartbeat{}
	h.SetWebSocketClient(ws)

	type sent struct {
		client    *websocket.Client
		id, stage string
	}
	var got []sent
	sendCommandProgress = func(c *websocket.Client, id, stage string) error {
		got = append(got, sent{c, id, stage})
		return nil
	}
	var gotPayload map[string]any
	installSoftwareWithOptions = func(payload map[string]any, progress tools.ProgressReporter, _ tools.InstallOptions) tools.CommandResult {
		gotPayload = payload
		if progress == nil {
			t.Fatal("handler passed a nil progress reporter despite a WebSocket client")
		}
		progress(tools.ProgressStageDownloading)
		progress(tools.ProgressStageInstalling)
		return tools.CommandResult{Status: "completed"}
	}

	payload := map[string]any{"deploymentId": "dep-1"}
	result := handleSoftwareInstall(h, Command{ID: "cmd-row-uuid", Type: tools.CmdSoftwareInstall, Payload: payload})

	if result.Status != "completed" {
		t.Fatalf("status = %q, want the install's own result", result.Status)
	}
	if !reflect.DeepEqual(gotPayload, payload) {
		t.Fatalf("install got payload %v, want %v", gotPayload, payload)
	}
	want := []sent{
		{ws, "cmd-row-uuid", tools.ProgressStageDownloading},
		{ws, "cmd-row-uuid", tools.ProgressStageInstalling},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %+v, want %+v", got, want)
	}
}

// #6958: the handler gives the install this command's id (the script
// execution-id prefix) and a runner backed by the heartbeat's executor — or
// no runner at all when there is no executor, so a scripted install fails
// closed instead of skipping its script.
func TestHandleSoftwareInstall_WiresScriptRunner(t *testing.T) {
	origInstall := installSoftwareWithOptions
	t.Cleanup(func() { installSoftwareWithOptions = origInstall })

	var gotOpts tools.InstallOptions
	installSoftwareWithOptions = func(_ map[string]any, _ tools.ProgressReporter, opts tools.InstallOptions) tools.CommandResult {
		gotOpts = opts
		return tools.CommandResult{Status: "completed"}
	}

	handleSoftwareInstall(&Heartbeat{}, Command{ID: "cmd-a", Type: tools.CmdSoftwareInstall, Payload: map[string]any{}})
	if gotOpts.CommandID != "cmd-a" || gotOpts.RunScript != nil {
		t.Fatalf("without an executor: opts = %+v, want CommandID cmd-a and a nil runner", gotOpts)
	}

	handleSoftwareInstall(&Heartbeat{executor: executor.New(nil)}, Command{ID: "cmd-b", Type: tools.CmdSoftwareInstall, Payload: map[string]any{}})
	if gotOpts.CommandID != "cmd-b" || gotOpts.RunScript == nil {
		t.Fatalf("with an executor: opts = %+v, want CommandID cmd-b and a runner", gotOpts)
	}
}

func requirePOSIXShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("drives a real bash script through the executor")
	}
}

// The values reach the script as BREEZE_PARAM_* references, rendered by the
// real executor: the script prints them, and they arrive intact.
func TestInstallScriptRunner_RealExecutorRendersParameters(t *testing.T) {
	requirePOSIXShell(t)
	run := installScriptRunner(executor.New(nil))
	res, err := run(tools.InstallScriptRequest{
		ID:         "cmd-render-post",
		ScriptType: "bash",
		Script:     "echo \"code={{var_code}} dir={{install_dir}}\"\n",
		Parameters: map[string]string{
			"var_code":    "abc; echo injected",
			"install_dir": "/tmp/breeze sw",
		},
		TimeoutSeconds: 30,
	})
	if err != nil {
		t.Fatalf("run: %v (%+v)", err, res)
	}
	if res.ExitCode != 0 || res.TimedOut || strings.TrimSpace(res.Stdout) != "code=abc; echo injected dir=/tmp/breeze sw" {
		t.Fatalf("result = %+v, want the parameter values printed verbatim (as data)", res)
	}
}

// Pins executorTimeoutPrefix to the executor's real timeout report, and that
// the run is killed rather than waited out.
func TestInstallScriptRunner_RealExecutorTimeout(t *testing.T) {
	requirePOSIXShell(t)
	run := installScriptRunner(executor.New(nil))
	began := time.Now()
	res, err := run(tools.InstallScriptRequest{
		ID:             "cmd-timeout-pre",
		ScriptType:     "bash",
		Script:         "sleep 30 &\nwait\n",
		TimeoutSeconds: 1,
	})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.TimedOut || res.ExitCode != -1 {
		t.Fatalf("result = %+v, want TimedOut with exit -1", res)
	}
	if elapsed := time.Since(began); elapsed > 15*time.Second {
		t.Fatalf("timed-out script held the install for %v", elapsed)
	}
}

// An executor refusal (here an unknown script type) is an error, not a timeout.
func TestInstallScriptRunner_RealExecutorRefusal(t *testing.T) {
	run := installScriptRunner(executor.New(nil))
	res, err := run(tools.InstallScriptRequest{ID: "cmd-refuse-pre", ScriptType: "cobol", Script: "x"})
	if err == nil || res == nil || res.TimedOut {
		t.Fatalf("got (%+v, %v), want a refusal error that is not a timeout", res, err)
	}
}

func TestInstallScriptRunner_NilExecutor(t *testing.T) {
	if installScriptRunner(nil) != nil {
		t.Fatal("a nil executor must yield a nil runner")
	}
}

// authoredTokenPattern is the authored install-script token grammar PR C
// rewrites to executor placeholders before dispatch: {{var.x}} → {{var_x}},
// {{install.dir}} → {{install_dir}}, {{install.file}} → {{install_file}}.
var authoredTokenPattern = regexp.MustCompile(`\{\{(var|install)\.([A-Za-z0-9_-]+)\}\}`)

// TestBuiltinScripts_RenderAndPassContentValidation is the fixture test for
// the built-in DNS-client scripts (PR D's constants are byte copies of these
// files). Each must render through the executor's parameter references with
// its documented keys, leave no placeholder behind, splice no value into the
// text, and pass the executor's strict content validation unchanged.
func TestBuiltinScripts_RenderAndPassContentValidation(t *testing.T) {
	dir := filepath.Join("..", "remote", "tools", "testdata", "builtin_scripts")
	wantKeys := map[string][]string{
		"controld_windows_post.ps1": {"install_dir", "var_controld_provisioning_code"},
		"controld_macos_pre.sh":     {"var_controld_provisioning_code"},
		"controld_macos_post.sh":    {},
		"nextdns_windows_post.ps1":  {"install_dir", "var_nextdns_profile_id"},
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(wantKeys) {
		t.Fatalf("fixtures = %d files, want %d", len(entries), len(wantKeys))
	}
	validator := executor.NewSecurityValidator(executor.SecurityLevelStrict)

	for _, e := range entries {
		name := e.Name()
		t.Run(name, func(t *testing.T) {
			keys, ok := wantKeys[name]
			if !ok {
				t.Fatalf("unexpected fixture %s", name)
			}
			raw, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			lang := executor.ScriptTypeBash
			if strings.HasSuffix(name, ".ps1") {
				lang = executor.ScriptTypePowerShell
			}

			content := authoredTokenPattern.ReplaceAllString(string(raw), "{{${1}_${2}}}")
			params := map[string]string{
				"install_dir":  "SENTINEL_INSTALL_DIR",
				"install_file": "SENTINEL_INSTALL_FILE",
			}
			var found []string
			for _, m := range regexp.MustCompile(`\{\{([A-Za-z0-9_-]+)\}\}`).FindAllStringSubmatch(content, -1) {
				found = append(found, m[1])
				if strings.HasPrefix(m[1], "var_") {
					params[m[1]] = "SENTINEL_" + strings.ToUpper(m[1])
				}
			}
			if !sameKeySet(found, keys) {
				t.Fatalf("placeholders = %v, want exactly %v", found, keys)
			}

			rendered, didRender, err := executor.RenderParameterReferences(content, lang, params)
			if err != nil {
				t.Fatalf("RenderParameterReferences: %v", err)
			}
			if len(keys) > 0 && !didRender {
				t.Fatal("no placeholder was rendered")
			}
			if strings.Contains(rendered, "{{") || strings.Contains(rendered, "SENTINEL_") {
				t.Fatalf("rendered script still has a placeholder or a spliced value:\n%s", rendered)
			}
			if err := validator.Validate(rendered); err != nil {
				t.Fatalf("executor content validation refused the script: %v\n%s", err, rendered)
			}
			// The executor also refuses a rendered bash script that does not
			// parse (`bash -n`), before running any of it.
			if lang == executor.ScriptTypeBash && runtime.GOOS != "windows" {
				tmp := filepath.Join(t.TempDir(), name)
				if err := os.WriteFile(tmp, []byte(rendered), 0o600); err != nil {
					t.Fatal(err)
				}
				if out, err := exec.Command("bash", "-n", tmp).CombinedOutput(); err != nil {
					t.Fatalf("rendered script fails bash -n: %v\n%s", err, out)
				}
			}
		})
	}
}

// Review Focus 5 (macOS managed preferences): the pre-script never overwrites
// a prefs file it did not write, marks the one it writes and makes it
// root-only (0600; spelled symbolically because the executor's strict
// "setuid/setgid chmod" pattern matches any octal `chmod [4-7]xx`), and the
// post-script deletes only a marked file.
func TestBuiltinScripts_MacOSManagedPrefsGuards(t *testing.T) {
	dir := filepath.Join("..", "remote", "tools", "testdata", "builtin_scripts")
	pre, err := os.ReadFile(filepath.Join(dir, "controld_macos_pre.sh"))
	if err != nil {
		t.Fatal(err)
	}
	post, err := os.ReadFile(filepath.Join(dir, "controld_macos_post.sh"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`BreezeWritten 2>/dev/null)" != "1" ]; then`, // foreign file → leave it
		`defaults write "$DOMAIN" BreezeWritten -bool true`,
		`chmod u=rw,go= "$DOMAIN.plist"`,
	} {
		if !strings.Contains(string(pre), want) {
			t.Errorf("pre-script lacks %q", want)
		}
	}
	if !strings.Contains(string(post), `BreezeWritten 2>/dev/null)" = "1" ]; then rm -f "$DOMAIN.plist"; fi`) {
		t.Error("post-script must delete the prefs file only behind the BreezeWritten marker")
	}
}

func sameKeySet(got, want []string) bool {
	set := map[string]bool{}
	for _, k := range got {
		set[k] = true
	}
	if len(set) != len(want) {
		return false
	}
	for _, k := range want {
		if !set[k] {
			return false
		}
	}
	return true
}

func TestCommandProgressReporter_ForwardsCommandIDAndStage(t *testing.T) {
	type sent struct{ id, stage string }
	var got []sent
	report := newCommandProgressReporter("cmd-sw-1", func(id, stage string) error {
		got = append(got, sent{id, stage})
		return nil
	})

	report("downloading")
	report("installing")

	want := []sent{{"cmd-sw-1", "downloading"}, {"cmd-sw-1", "installing"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %v, want %v", got, want)
	}
}

// A progress send can fail (old server, full channel, stopped client); the
// install must carry on regardless, so the reporter swallows every error.
func TestCommandProgressReporter_SwallowsSendErrors(t *testing.T) {
	for _, sendErr := range []error{websocket.ErrServerLacksCapability, errors.New("send channel full")} {
		report := newCommandProgressReporter("cmd-sw-1", func(string, string) error { return sendErr })
		report("downloading") // must not panic
	}
}

func TestHeartbeatCommandProgressReporter_NilWithoutWebSocket(t *testing.T) {
	var nilHeartbeat *Heartbeat
	if nilHeartbeat.commandProgressReporter("cmd-sw-1") != nil {
		t.Fatal("nil heartbeat must yield a nil reporter")
	}
	if (&Heartbeat{}).commandProgressReporter("cmd-sw-1") != nil {
		t.Fatal("heartbeat without a websocket client must yield a nil reporter")
	}
}
