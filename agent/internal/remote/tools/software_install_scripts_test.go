package tools

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

// hostScriptLanguage is the only install-script language this host accepts.
func hostScriptLanguage() string {
	if runtime.GOOS == "windows" {
		return "powershell"
	}
	return "bash"
}

func scriptPayload(content string, params map[string]any) map[string]any {
	s := map[string]any{
		"language":       hostScriptLanguage(),
		"content":        content,
		"timeoutSeconds": float64(600),
	}
	if params != nil {
		s["parameters"] = params
	}
	return s
}

// fakeRunner records every request it receives and answers from respond.
type fakeRunner struct {
	order    *[]string
	requests []InstallScriptRequest
	respond  func(req InstallScriptRequest) (*InstallScriptResult, error)
}

func (f *fakeRunner) run(req InstallScriptRequest) (*InstallScriptResult, error) {
	f.requests = append(f.requests, req)
	phase := req.ID[strings.LastIndex(req.ID, "-")+1:]
	if f.order != nil {
		*f.order = append(*f.order, phase)
	}
	if f.respond != nil {
		return f.respond(req)
	}
	return &InstallScriptResult{ExitCode: 0, Stdout: phase + " ok"}, nil
}

func scriptedInstall(t *testing.T, order *[]string, installErr error) map[string]any {
	t.Helper()
	recordingPipeline(t, order, installErr)
	p := installPayload("https://downloads.example.com/pkg.exe", nil)
	p["preInstallScript"] = scriptPayload("echo pre", nil)
	p["postInstallScript"] = scriptPayload("echo post", nil)
	return p
}

func decodeSuccess(t *testing.T, res CommandResult) map[string]any {
	t.Helper()
	if res.Status != "completed" {
		t.Fatalf("status = %q (error %q), want completed", res.Status, res.Error)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("success stdout is not JSON: %v (%q)", err, res.Stdout)
	}
	return out
}

func TestInstallScripts_RunInOrderAroundTheInstaller(t *testing.T) {
	var order []string
	swCheckpointProbe(t, &order)
	p := withSoftwareBlock(scriptedInstall(t, &order, nil))
	runner := &fakeRunner{order: &order}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	out := decodeSuccess(t, res)
	// The restore checkpoint is taken before the pre-script: the pre-script is
	// the install's first mutation now (D3 order, step 5).
	if want := []string{"download", "checkpoint", "pre", "installer", "post"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for _, key := range []string{"preInstallScript", "postInstallScript"} {
		s, ok := out[key].(map[string]any)
		if !ok {
			t.Fatalf("result lacks %s: %v", key, out)
		}
		if s["exitCode"] != float64(0) || s["output"] == "" || s["durationMs"] == nil {
			t.Fatalf("%s = %v, want exitCode/output/durationMs", key, s)
		}
	}
	if got := []string{runner.requests[0].ID, runner.requests[1].ID}; !reflect.DeepEqual(got, []string{"cmd-1-pre", "cmd-1-post"}) {
		t.Fatalf("execution ids = %v", got)
	}
}

func TestInstallScripts_PreFailureSkipsTheInstaller(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, nil)
	runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
		return &InstallScriptResult{ExitCode: 3, Stdout: "nope"}, nil
	}}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	if res.Status != "failed" || res.ExitCode != 3 || !strings.Contains(res.Error, "pre_install_script_failed") {
		t.Fatalf("result = %+v, want pre_install_script_failed with exitCode 3", res)
	}
	if want := []string{"download", "pre"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v (installer and post must not run)", order, want)
	}
	if !strings.Contains(res.Stdout, "nope") {
		t.Fatalf("stdout = %q, want the pre-script output", res.Stdout)
	}
}

func TestInstallScripts_InstallerFailureSkipsPost(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, errors.New("installer exited with code 1603"))
	runner := &fakeRunner{order: &order}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if want := []string{"download", "pre", "installer"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
}

func TestInstallScripts_PostFailureFailsWithoutDetection(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, nil)
	p["detectionRules"] = []any{map[string]any{"type": "service_running", "serviceName": "ctrld"}}
	pre := true
	stubServiceStatus(t, func(string) (bool, bool) {
		if pre {
			return false, true // pre-gate: not installed yet
		}
		t.Fatal("post-install detection must not run after a failed post-script")
		return false, false
	})
	runner := &fakeRunner{order: &order, respond: func(req InstallScriptRequest) (*InstallScriptResult, error) {
		if strings.HasSuffix(req.ID, "-post") {
			pre = false
			return &InstallScriptResult{ExitCode: 1, Stderr: "enroll failed"}, nil
		}
		return &InstallScriptResult{}, nil
	}}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	if res.Status != "failed" || res.ExitCode != 1 || !strings.Contains(res.Error, "post_install_script_failed") {
		t.Fatalf("result = %+v, want post_install_script_failed exit 1", res)
	}
	if !strings.Contains(res.Stdout, "enroll failed") {
		t.Fatalf("stdout = %q, want the post-script stderr", res.Stdout)
	}
}

func TestInstallScripts_DetectedPackageRunsNoScript(t *testing.T) {
	stubInstallPipeline(t,
		func(*http.Client, string, string) error { t.Fatal("no download"); return nil },
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("no installer")
			return 0, "", false, nil
		},
	)
	stubServiceStatus(t, func(string) (bool, bool) { return true, true })
	p := installPayload("https://downloads.example.com/pkg.exe", nil)
	p["preInstallScript"] = scriptPayload("echo pre", nil)
	p["detectionRules"] = []any{map[string]any{"type": "service_running", "serviceName": "ctrld"}}

	// A nil runner too: an already-installed package needs no runner.
	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1"})

	out := decodeSuccess(t, res)
	if out["skipped"] != true {
		t.Fatalf("result = %v, want skipped", out)
	}
}

func TestInstallScripts_VarValuesAreRedactedFromOutput(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, nil)
	const code = "prov-CODE-123456"
	p["postInstallScript"] = scriptPayload("echo {{var_code}}", map[string]any{
		"var_code":    code,
		"org_name":    "Acme Org",
		"var_empty":   "",
		"var_partial": "prov-CODE",
	})
	runner := &fakeRunner{order: &order, respond: func(req InstallScriptRequest) (*InstallScriptResult, error) {
		if strings.HasSuffix(req.ID, "-post") {
			if req.Parameters["var_code"] != code {
				t.Fatalf("parameters = %v, want var_code delivered", req.Parameters)
			}
			return &InstallScriptResult{Stdout: "enrolled with " + code + " for Acme Org", Stderr: "warn: " + code}, nil
		}
		return &InstallScriptResult{}, nil
	}}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	if strings.Contains(res.Stdout, "CODE") {
		t.Fatalf("a var_ value leaked into the result: %s", res.Stdout)
	}
	out := decodeSuccess(t, res)
	post := out["postInstallScript"].(map[string]any)
	if got := post["output"].(string); !strings.Contains(got, "enrolled with [redacted]") || !strings.Contains(got, "Acme Org") {
		t.Fatalf("post output = %q, want the var_ value redacted and non-var values kept", got)
	}

	// The failure path redacts too.
	order = nil
	p = scriptedInstall(t, &order, nil)
	p["preInstallScript"] = scriptPayload("echo {{var_code}}", map[string]any{"var_code": code})
	runner = &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
		return &InstallScriptResult{ExitCode: 2, Stdout: "bad code " + code, Error: "failed near " + code}, nil
	}}
	res = InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-2", RunScript: runner.run})
	if res.Status != "failed" || strings.Contains(res.Stdout+res.Error, code) {
		t.Fatalf("failure result leaked the var_ value: %+v", res)
	}
}

func TestInstallScripts_AgentOwnsInstallDirAndInstallFile(t *testing.T) {
	for _, key := range []string{"install_dir", "install_file", "INSTALL_DIR", "install-dir", "Install-File"} {
		t.Run(key, func(t *testing.T) {
			stubInstallPipeline(t,
				func(*http.Client, string, string) error { t.Fatal("no download"); return nil },
				func(string, string, string, []uint32) (int, string, bool, error) {
					t.Fatal("no installer")
					return 0, "", false, nil
				},
			)
			p := installPayload("https://downloads.example.com/pkg.exe", nil)
			p["postInstallScript"] = scriptPayload("echo hi", map[string]any{key: "/tmp/attacker"})
			res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: (&fakeRunner{}).run})
			if res.Status != "failed" || !strings.Contains(res.Error, "reserved") {
				t.Fatalf("result = %+v, want a refusal of the server-sent %s", res, key)
			}
		})
	}

	// And the agent fills both with the real staging paths.
	var order []string
	p := scriptedInstall(t, &order, nil)
	runner := &fakeRunner{order: &order, respond: func(req InstallScriptRequest) (*InstallScriptResult, error) {
		dir, file := req.Parameters["install_dir"], req.Parameters["install_file"]
		if dir == "" || filepath.Dir(file) != dir {
			t.Fatalf("install_dir=%q install_file=%q, want the file inside the dir", dir, file)
		}
		if _, err := os.Stat(file); err != nil {
			t.Fatalf("install_file not on disk during %s: %v", req.ID, err)
		}
		return &InstallScriptResult{}, nil
	}}
	decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run}))
}

func TestInstallScripts_NilRunnerFailsClosed(t *testing.T) {
	stubInstallPipeline(t,
		func(*http.Client, string, string) error { t.Fatal("no download"); return nil },
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("no installer")
			return 0, "", false, nil
		},
	)
	p := installPayload("https://downloads.example.com/pkg.exe", nil)
	p["postInstallScript"] = scriptPayload("echo hi", nil)

	for name, install := range map[string]func() CommandResult{
		"options":  func() CommandResult { return InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1"}) },
		"progress": func() CommandResult { return InstallSoftwareWithProgress(p, nil) },
		"legacy":   func() CommandResult { return InstallSoftware(p) },
	} {
		t.Run(name, func(t *testing.T) {
			res := install()
			if res.Status != "failed" || !strings.Contains(res.Error, "install_script_runner_unavailable") {
				t.Fatalf("result = %+v, want install_script_runner_unavailable", res)
			}
		})
	}
}

// A package-manager install has no staging dir or installer step to hang a
// script on; a script must never be silently dropped, so it is refused.
func TestInstallScripts_RefusedWithPackageManagerInstall(t *testing.T) {
	p := map[string]any{
		"softwareName":      "Acme",
		"installMethod":     map[string]any{"kind": "winget", "packageId": "Acme.App"},
		"postInstallScript": scriptPayload("echo hi", nil),
	}
	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: func(InstallScriptRequest) (*InstallScriptResult, error) {
		t.Fatal("no script may run")
		return nil, nil
	}})
	if res.Status != "failed" || !strings.Contains(res.Error, "package-manager") {
		t.Fatalf("result = %+v, want the package-manager refusal", res)
	}
}

func TestInstallScripts_ServiceRunningPolledUntilMet(t *testing.T) {
	origWindow, origInterval := detectionSettleWindow, detectionSettleInterval
	detectionSettleWindow, detectionSettleInterval = 5*time.Second, time.Millisecond
	t.Cleanup(func() { detectionSettleWindow, detectionSettleInterval = origWindow, origInterval })

	var order []string
	p := scriptedInstall(t, &order, nil)
	p["detectionRules"] = []any{map[string]any{"type": "service_running", "serviceName": "ctrld"}}
	polls := 0
	installed := false
	stubServiceStatus(t, func(string) (bool, bool) {
		if !installed {
			return false, true // pre-gate
		}
		polls++
		return polls >= 3, true
	})
	runner := &fakeRunner{order: &order, respond: func(req InstallScriptRequest) (*InstallScriptResult, error) {
		if strings.HasSuffix(req.ID, "-post") {
			installed = true
		}
		return &InstallScriptResult{}, nil
	}}

	out := decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run}))

	if polls != 3 || out["detectionSatisfied"] != true {
		t.Fatalf("polls = %d, result = %v; want success on the third poll", polls, out)
	}
}

func TestInstallScripts_ServiceRunningNeverMetFails(t *testing.T) {
	origWindow, origInterval := detectionSettleWindow, detectionSettleInterval
	detectionSettleWindow, detectionSettleInterval = 20*time.Millisecond, time.Millisecond
	t.Cleanup(func() { detectionSettleWindow, detectionSettleInterval = origWindow, origInterval })

	var order []string
	p := scriptedInstall(t, &order, nil)
	p["detectionRules"] = []any{map[string]any{"type": "service_running", "serviceName": "ctrld"}}
	stubServiceStatus(t, func(string) (bool, bool) { return false, true })

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: (&fakeRunner{order: &order}).run})

	if res.Status != "failed" || !strings.Contains(res.Error, "detection rule was not satisfied") {
		t.Fatalf("result = %+v, want a detection failure", res)
	}
}

func TestInstallScripts_StagingRemovedOnlyAfterPost(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, nil)
	var stagingDir string
	runner := &fakeRunner{order: &order, respond: func(req InstallScriptRequest) (*InstallScriptResult, error) {
		stagingDir = req.Parameters["install_dir"]
		if _, err := os.Stat(stagingDir); err != nil {
			t.Fatalf("staging dir gone during %s: %v", req.ID, err)
		}
		return &InstallScriptResult{}, nil
	}}

	decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run}))

	if stagingDir == "" {
		t.Fatal("runner never saw install_dir")
	}
	if _, err := os.Stat(stagingDir); !os.IsNotExist(err) {
		t.Fatalf("staging dir still present after the install: %v", err)
	}
}

func TestInstallScripts_TimeoutIsReported(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, nil)
	runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
		return &InstallScriptResult{ExitCode: -1, TimedOut: true, Error: "execution timed out after 600 seconds"}, nil
	}}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	if res.Status != "failed" || !strings.Contains(res.Error, "install_script_timeout") {
		t.Fatalf("result = %+v, want install_script_timeout", res)
	}
	if want := []string{"download", "pre"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
}

// A runner that refuses the script outright (render failure, content
// validation, duplicate id) is a script failure, never a silent skip.
func TestInstallScripts_RunnerRefusalFailsTheInstall(t *testing.T) {
	var order []string
	p := scriptedInstall(t, &order, nil)
	runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
		return &InstallScriptResult{ExitCode: -1, Error: "script validation failed: x"}, errors.New("script validation failed: x")
	}}

	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})

	if res.Status != "failed" || !strings.Contains(res.Error, "pre_install_script_failed") || !strings.Contains(res.Error, "script validation failed") {
		t.Fatalf("result = %+v, want pre_install_script_failed naming the refusal", res)
	}
}

func TestInstallScriptTimeoutClamp(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want time.Duration
	}{
		{"missing", nil, 600 * time.Second},
		{"zero", float64(0), 600 * time.Second},
		{"negative", float64(-5), 600 * time.Second},
		{"fractional", 1.5, 600 * time.Second},
		{"string", "30", 600 * time.Second},
		{"above the ceiling", float64(601), 600 * time.Second},
		{"plan's old 1800 bound", float64(1800), 600 * time.Second},
		{"one second", float64(1), time.Second},
		{"in range", float64(30), 30 * time.Second},
		{"at the ceiling", float64(600), 600 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := installScriptTimeoutFor(tt.raw); got != tt.want {
				t.Fatalf("installScriptTimeoutFor(%v) = %v, want %v", tt.raw, got, tt.want)
			}
		})
	}
	if installScriptTimeout != 10*time.Minute {
		t.Fatalf("installScriptTimeout = %v, want 10m (SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS)", installScriptTimeout)
	}

	// The clamped value is what reaches the runner, in seconds.
	var order []string
	p := scriptedInstall(t, &order, nil)
	p["preInstallScript"].(map[string]any)["timeoutSeconds"] = float64(1800)
	p["postInstallScript"].(map[string]any)["timeoutSeconds"] = float64(45)
	runner := &fakeRunner{order: &order}
	decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run}))
	if got := []int{runner.requests[0].TimeoutSeconds, runner.requests[1].TimeoutSeconds}; !reflect.DeepEqual(got, []int{600, 45}) {
		t.Fatalf("runner timeouts = %v, want [600 45]", got)
	}
}

// The executor refuses a second execution with an id that is still running, so
// two installs must never share one.
func TestInstallScripts_ExecutionIDsAreUniquePerInstall(t *testing.T) {
	seen := map[string]bool{}
	for _, commandID := range []string{"cmd-a", "cmd-b", "", ""} {
		var order []string
		p := scriptedInstall(t, &order, nil)
		runner := &fakeRunner{order: &order}
		decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: commandID, RunScript: runner.run}))
		for _, req := range runner.requests {
			if seen[req.ID] {
				t.Fatalf("execution id %q reused across installs", req.ID)
			}
			seen[req.ID] = true
			if commandID != "" && !strings.HasPrefix(req.ID, commandID+"-") {
				t.Fatalf("id %q does not carry command id %q", req.ID, commandID)
			}
		}
	}
}

func TestInstallScripts_RefusesMalformedScripts(t *testing.T) {
	wrongLang := "bash"
	if runtime.GOOS != "windows" {
		wrongLang = "powershell"
	}
	tests := map[string]any{
		"not an object":        "echo hi",
		"wrong OS language":    map[string]any{"language": wrongLang, "content": "echo hi"},
		"unknown language":     map[string]any{"language": "python", "content": "print(1)"},
		"blank content":        map[string]any{"language": hostScriptLanguage(), "content": "  \n"},
		"oversized content":    map[string]any{"language": hostScriptLanguage(), "content": strings.Repeat("x", 65537)},
		"non-string param":     map[string]any{"language": hostScriptLanguage(), "content": "echo", "parameters": map[string]any{"var_x": float64(1)}},
		"bad param key":        map[string]any{"language": hostScriptLanguage(), "content": "echo", "parameters": map[string]any{"var x": "1"}},
		"NUL in param value":   map[string]any{"language": hostScriptLanguage(), "content": "echo", "parameters": map[string]any{"var_x": "a\x00b"}},
		"parameters not a map": map[string]any{"language": hostScriptLanguage(), "content": "echo", "parameters": []any{"x"}},
	}
	for name, script := range tests {
		t.Run(name, func(t *testing.T) {
			stubInstallPipeline(t,
				func(*http.Client, string, string) error { t.Fatal("no download"); return nil },
				func(string, string, string, []uint32) (int, string, bool, error) {
					t.Fatal("no installer")
					return 0, "", false, nil
				},
			)
			p := installPayload("https://downloads.example.com/pkg.exe", nil)
			p["postInstallScript"] = script
			res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: (&fakeRunner{}).run})
			if res.Status != "failed" || !strings.Contains(res.Error, "postInstallScript") {
				t.Fatalf("result = %+v, want a refusal naming postInstallScript", res)
			}
		})
	}
}

// The staging dir holds the downloaded package and its extracted contents; it
// is removed on every failure path too, not only after a clean install.
func TestInstallScripts_StagingRemovedOnFailurePaths(t *testing.T) {
	fail := func(phase string) func(InstallScriptRequest) (*InstallScriptResult, error) {
		return func(req InstallScriptRequest) (*InstallScriptResult, error) {
			if strings.HasSuffix(req.ID, "-"+phase) {
				return &InstallScriptResult{ExitCode: 7}, nil
			}
			return &InstallScriptResult{}, nil
		}
	}
	tests := []struct {
		name       string
		zip        bool
		installErr error
		respond    func(InstallScriptRequest) (*InstallScriptResult, error)
		detection  bool
	}{
		{name: "pre-script fails", respond: fail("pre")},
		{name: "installer fails", installErr: errors.New("installer exited with code 1603")},
		{name: "post-script fails", respond: fail("post")},
		{name: "archive rejected", zip: true},
		{name: "detection never met", detection: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			origWindow, origInterval := detectionSettleWindow, detectionSettleInterval
			detectionSettleWindow, detectionSettleInterval = 10*time.Millisecond, time.Millisecond
			t.Cleanup(func() { detectionSettleWindow, detectionSettleInterval = origWindow, origInterval })

			var staging string
			stubInstallPipeline(t,
				func(_ *http.Client, _ string, dest string) error {
					staging = filepath.Dir(dest)
					if tt.zip {
						return os.WriteFile(dest, buildZip(t, []zipEntry{{name: "../evil", body: "x"}}), 0o600)
					}
					return os.WriteFile(dest, fakeInstallerBytes, 0o600)
				},
				func(string, string, string, []uint32) (int, string, bool, error) {
					if tt.installErr != nil {
						return 1, "boom", false, tt.installErr
					}
					return 0, "ok", false, nil
				},
			)
			p := installPayload("https://downloads.example.com/pkg.exe", nil)
			if tt.zip {
				p = zipInstallPayload()
			} else {
				p["preInstallScript"] = scriptPayload("echo pre", nil)
			}
			p["postInstallScript"] = scriptPayload("echo post", nil)
			if tt.detection {
				p["detectionRules"] = []any{map[string]any{"type": "service_running", "serviceName": "ctrld"}}
				stubServiceStatus(t, func(string) (bool, bool) { return false, true })
			}

			res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: (&fakeRunner{respond: tt.respond}).run})

			if res.Status != "failed" {
				t.Fatalf("status = %q, want failed", res.Status)
			}
			if staging == "" {
				t.Fatal("download never ran")
			}
			if _, err := os.Stat(staging); !os.IsNotExist(err) {
				t.Fatalf("staging dir %s left behind: %v", staging, err)
			}
		})
	}
}

// The day's one restore point is only spent once the install will mutate:
// never for an already-installed package or a failed download, and before the
// pre-script when there is one.
func TestInstallScripts_CheckpointBoundary(t *testing.T) {
	t.Run("already installed", func(t *testing.T) {
		calls := swCheckpointProbe(t, nil)
		stubServiceStatus(t, func(string) (bool, bool) { return true, true })
		p := withSoftwareBlock(installPayload("https://downloads.example.com/pkg.exe", nil))
		p["preInstallScript"] = scriptPayload("echo pre", nil)
		p["detectionRules"] = []any{map[string]any{"type": "service_running", "serviceName": "ctrld"}}
		res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: (&fakeRunner{}).run})
		if *calls != 0 {
			t.Fatalf("checkpoint attempts = %d, want 0", *calls)
		}
		requireNoMutation(t, res)
	})

	t.Run("download fails", func(t *testing.T) {
		var order []string
		calls := swCheckpointProbe(t, &order)
		stubInstallPipeline(t,
			func(*http.Client, string, string) error { return errors.New("connection reset") },
			func(string, string, string, []uint32) (int, string, bool, error) { return 0, "", false, nil },
		)
		p := withSoftwareBlock(installPayload("https://downloads.example.com/pkg.exe", nil))
		p["preInstallScript"] = scriptPayload("echo pre", nil)
		runner := &fakeRunner{order: &order}
		res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})
		if *calls != 0 || len(runner.requests) != 0 {
			t.Fatalf("checkpoint attempts = %d, scripts run = %d; want 0 and 0", *calls, len(runner.requests))
		}
		requireNoMutation(t, res)
	})

	t.Run("pre-script fails after the checkpoint", func(t *testing.T) {
		var order []string
		swCheckpointProbe(t, &order)
		p := withSoftwareBlock(scriptedInstall(t, &order, nil))
		runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
			return &InstallScriptResult{ExitCode: 1}, nil
		}}
		InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})
		if want := []string{"download", "checkpoint", "pre"}; !reflect.DeepEqual(order, want) {
			t.Fatalf("order = %v, want %v", order, want)
		}
	})
}

func TestInstallScripts_RedactionEdgeCases(t *testing.T) {
	const code = "prov-CODE-123456"

	t.Run("runner error with no result", func(t *testing.T) {
		var order []string
		p := scriptedInstall(t, &order, nil)
		p["preInstallScript"] = scriptPayload("echo {{var_code}}", map[string]any{"var_code": code})
		runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
			return nil, errors.New("render failed near " + code)
		}}
		res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})
		if res.Status != "failed" || !strings.Contains(res.Error, "render failed near [redacted]") || strings.Contains(res.Error+res.Stdout, code) {
			t.Fatalf("result = %+v, want the runner error redacted", res)
		}
	})

	t.Run("upper-case VAR_ key", func(t *testing.T) {
		var order []string
		p := scriptedInstall(t, &order, nil)
		p["postInstallScript"] = scriptPayload("echo hi", map[string]any{"VAR_Code": code})
		runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
			return &InstallScriptResult{Stdout: "got " + code}, nil
		}}
		res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run})
		if res.Status != "completed" || strings.Contains(res.Stdout, code) {
			t.Fatalf("result = %+v, want the VAR_ value redacted", res)
		}
	})

	t.Run("secret at the truncation boundary", func(t *testing.T) {
		var order []string
		p := scriptedInstall(t, &order, nil)
		p["postInstallScript"] = scriptPayload("echo hi", map[string]any{"var_code": code})
		// The value straddles the output cap: truncating first would leave a
		// prefix of it that a later replace can no longer match.
		filler := strings.Repeat("a", maxInstallerOutputBytes-len(code)/2)
		runner := &fakeRunner{order: &order, respond: func(InstallScriptRequest) (*InstallScriptResult, error) {
			return &InstallScriptResult{Stdout: filler + code + "tail"}, nil
		}}
		out := decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run}))
		got := out["postInstallScript"].(map[string]any)["output"].(string)
		if strings.Contains(got, code[:len(code)/2]) {
			t.Fatalf("a prefix of the var_ value survived truncation: ...%q", got[len(got)-40:])
		}
	})
}

// End to end for an archive: extracted files are under install_dir when the
// post-install script runs.
func TestInstallScripts_ZipExtractsForThePostScript(t *testing.T) {
	zipBytes := buildZip(t, []zipEntry{{name: "dist/x/ctrld.exe", body: "binary", mode: 0o755}})
	stubInstallPipeline(t,
		func(_ *http.Client, _ string, dest string) error { return os.WriteFile(dest, zipBytes, 0o600) },
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("a zip is extracted, never executed")
			return 0, "", false, nil
		},
	)
	p := zipInstallPayload()
	p["postInstallScript"] = scriptPayload("echo post", nil)
	runner := &fakeRunner{respond: func(req InstallScriptRequest) (*InstallScriptResult, error) {
		got, err := os.ReadFile(filepath.Join(req.Parameters["install_dir"], "dist", "x", "ctrld.exe"))
		if err != nil || string(got) != "binary" {
			t.Fatalf("extracted file = (%q, %v)", got, err)
		}
		return &InstallScriptResult{}, nil
	}}

	out := decodeSuccess(t, InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-1", RunScript: runner.run}))
	if out["fileType"] != "zip" || len(runner.requests) != 1 {
		t.Fatalf("result = %v, runner calls = %d", out, len(runner.requests))
	}

	// A corrupt archive fails before the post-script.
	stubInstallPipeline(t,
		func(_ *http.Client, _ string, dest string) error {
			return os.WriteFile(dest, []byte("not a zip"), 0o600)
		},
		func(string, string, string, []uint32) (int, string, bool, error) { return 0, "", false, nil },
	)
	runner = &fakeRunner{}
	res := InstallSoftwareWithOptions(p, nil, InstallOptions{CommandID: "cmd-2", RunScript: runner.run})
	if res.Status != "failed" || !strings.Contains(res.Error, "archive") || len(runner.requests) != 0 {
		t.Fatalf("result = %+v (runner calls %d), want an extraction failure before post", res, len(runner.requests))
	}
}
