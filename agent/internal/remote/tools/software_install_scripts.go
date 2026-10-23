package tools

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Pre/post-install scripts (#6958, plan D3). A software version may carry a
// script that runs before the installer and one that runs after it (for a
// zip, after extraction). They run through the agent's script executor as the
// agent service principal (SYSTEM / root), never as a user. Values reach the
// script only as parameters: the server rewrites authored `{{var.x}}`,
// `{{install.dir}}`, … tokens to executor placeholders (`{{var_x}}`,
// `{{install_dir}}`), and the executor turns those into BREEZE_PARAM_*
// environment references, so no value is ever spliced into script text.

// installScriptTimeout is each script's ceiling and the default when the
// payload's timeoutSeconds is missing or invalid. Mirrors
// SOFTWARE_INSTALL_SCRIPT_TIMEOUT_MS (pinned by
// TestInstallTimeoutsMatchSharedConstants). The server's 75-minute reaper is
// budgeted as download 15 + installer 30 + 2 scripts × 10 + settle 1, so a
// payload may shorten a script but never lengthen it past this.
const installScriptTimeout = 10 * time.Minute

const (
	// maxInstallScriptBytes mirrors INSTALL_SCRIPT_MAX_BYTES
	// (packages/shared/src/validators/softwareVersionInstallSpec.ts).
	maxInstallScriptBytes           = 65536
	maxInstallScriptParams          = 64
	maxInstallScriptParamValueBytes = 8192

	// Agent-owned parameters: set from the real staging paths, never taken
	// from the server.
	installScriptParamDir  = "install_dir"
	installScriptParamFile = "install_file"
)

// installScriptParamKeyPattern is the executor's placeholder grammar
// (executor/paramrefs.go placeholderPattern). Each key also becomes a
// BREEZE_PARAM_<KEY> environment variable name, so nothing else is allowed.
var installScriptParamKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// Failure codes. Each failed result's Error starts with "<code>: ". They are
// not wire.CommandErrorCode values: that list is pinned to the server's schema
// (apps/api), which this agent change does not touch.
const (
	installErrPreScriptFailed     = "pre_install_script_failed"
	installErrPostScriptFailed    = "post_install_script_failed"
	installErrScriptTimeout       = "install_script_timeout"
	installErrArchiveRequiresPost = "archive_requires_post_install_script"
	installErrRunnerUnavailable   = "install_script_runner_unavailable"
)

// InstallScriptRequest is one pre/post-install script run: the subset of
// executor.ScriptExecution an install script uses. tools cannot import
// executor (executor → privilege → tools), so the heartbeat handler adapts
// this to executor.Execute. There is deliberately no RunAs: install scripts
// run as the agent service principal.
type InstallScriptRequest struct {
	// ID is the execution id, "<commandId>-pre" / "<commandId>-post". The
	// executor refuses an id that is already running.
	ID             string
	ScriptType     string // "powershell" | "bash"
	Script         string
	Parameters     map[string]string
	TimeoutSeconds int
}

// InstallScriptResult is what the runner reports back.
type InstallScriptResult struct {
	ExitCode int
	Stdout   string
	Stderr   string
	// Error is the executor's own failure text (refusal, timeout, cancel).
	Error string
	// TimedOut: the script hit TimeoutSeconds and its process tree was killed.
	TimedOut bool
	// Truncated: the executor capped stdout or stderr.
	Truncated bool
}

// InstallScriptRunner runs one install script. A non-nil error means the
// script was refused or could not start; the result may still carry detail.
type InstallScriptRunner func(InstallScriptRequest) (*InstallScriptResult, error)

// InstallOptions carries what InstallSoftwareWithOptions needs beyond the
// payload.
type InstallOptions struct {
	// CommandID prefixes the script execution ids. When empty a random id is
	// used, so two installs never collide in the executor.
	CommandID string
	// RunScript executes pre/post-install scripts. Nil means this build cannot
	// run them: a payload carrying a script then fails with
	// install_script_runner_unavailable rather than skipping it.
	RunScript InstallScriptRunner
}

// installScript is one parsed, validated script from the payload.
type installScript struct {
	field      string // payload key, for error messages
	phase      string // "pre" | "post" (execution id suffix)
	label      string // "pre-install" | "post-install"
	errCode    string // failure code when it does not succeed
	language   string
	content    string
	parameters map[string]string
	timeout    time.Duration
}

// installScriptLanguageFor is the only language accepted on goos. The server
// binds a version with scripts to exactly one OS and picks the language from
// it (plan D3), so a mismatch is a malformed payload, refused before download.
func installScriptLanguageFor(goos string) string {
	if goos == "windows" {
		return "powershell"
	}
	return "bash"
}

// parseInstallScripts reads preInstallScript / postInstallScript. Absent or
// null keys are no script; anything malformed is an error.
func parseInstallScripts(payload map[string]any) (pre, post *installScript, err error) {
	pre, err = parseInstallScript(payload, "preInstallScript", "pre", "pre-install", installErrPreScriptFailed)
	if err != nil {
		return nil, nil, err
	}
	post, err = parseInstallScript(payload, "postInstallScript", "post", "post-install", installErrPostScriptFailed)
	if err != nil {
		return nil, nil, err
	}
	return pre, post, nil
}

func parseInstallScript(payload map[string]any, field, phase, label, errCode string) (*installScript, error) {
	raw, present := payload[field]
	if !present || raw == nil {
		return nil, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an object", field)
	}

	language, _ := obj["language"].(string)
	if want := installScriptLanguageFor(runtime.GOOS); language != want {
		return nil, fmt.Errorf("%s language %q cannot run on %s (want %q)", field, language, runtime.GOOS, want)
	}
	content, _ := obj["content"].(string)
	if strings.TrimSpace(content) == "" {
		return nil, fmt.Errorf("%s content is empty", field)
	}
	if len(content) > maxInstallScriptBytes {
		return nil, fmt.Errorf("%s content exceeds %d bytes", field, maxInstallScriptBytes)
	}

	params, err := parseInstallScriptParameters(field, obj["parameters"])
	if err != nil {
		return nil, err
	}

	return &installScript{
		field:      field,
		phase:      phase,
		label:      label,
		errCode:    errCode,
		language:   language,
		content:    content,
		parameters: params,
		timeout:    installScriptTimeoutFor(obj["timeoutSeconds"]),
	}, nil
}

func parseInstallScriptParameters(field string, raw any) (map[string]string, error) {
	params := map[string]string{}
	if raw == nil {
		return params, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s parameters must be an object", field)
	}
	if len(obj) > maxInstallScriptParams {
		return nil, fmt.Errorf("%s has more than %d parameters", field, maxInstallScriptParams)
	}
	for key, v := range obj {
		if !installScriptParamKeyPattern.MatchString(key) {
			return nil, fmt.Errorf("%s parameter name %q is invalid", field, key)
		}
		// Compare as the executor's environment name (case- and '-'/'_'-
		// folded), so INSTALL-DIR cannot shadow the agent's install_dir.
		switch envName := strings.ToUpper(strings.ReplaceAll(key, "-", "_")); envName {
		case strings.ToUpper(installScriptParamDir), strings.ToUpper(installScriptParamFile):
			return nil, fmt.Errorf("%s parameter %q is reserved: the agent sets it", field, key)
		}
		s, ok := v.(string)
		if !ok {
			return nil, fmt.Errorf("%s parameter %q must be a string", field, key)
		}
		if strings.ContainsRune(s, 0) || len(s) > maxInstallScriptParamValueBytes {
			return nil, fmt.Errorf("%s parameter %q has an invalid value", field, key)
		}
		params[key] = s
	}
	return params, nil
}

// installScriptTimeoutFor reads timeoutSeconds: a whole number of seconds in
// [1, installScriptTimeout] is used as is, a larger one is clamped down, and
// anything missing or invalid (zero, negative, fractional, non-numeric) is
// installScriptTimeout. The server always sends 600.
func installScriptTimeoutFor(raw any) time.Duration {
	f, ok := raw.(float64)
	if !ok || f != math.Trunc(f) || f < 1 || math.IsInf(f, 0) {
		return installScriptTimeout
	}
	if f >= installScriptTimeout.Seconds() {
		return installScriptTimeout
	}
	return time.Duration(f) * time.Second
}

// installScriptRunID is the prefix of this install's script execution ids.
func installScriptRunID(commandID string) string {
	if commandID != "" {
		return commandID
	}
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on supported platforms; a clock-derived id
		// still keeps two installs apart.
		return fmt.Sprintf("install-%d", time.Now().UnixNano())
	}
	return "install-" + hex.EncodeToString(b[:])
}

// installScriptRedactions are the var_* parameter values (tenant variables) of
// every script in this install, longest first so a value that contains
// another is replaced whole. The union, because either script can print a
// value the other one was given (both run on the same device and state).
func installScriptRedactions(scripts ...*installScript) []string {
	var values []string
	for _, s := range scripts {
		if s == nil {
			continue
		}
		for key, v := range s.parameters {
			if v != "" && strings.HasPrefix(strings.ToLower(key), "var_") {
				values = append(values, v)
			}
		}
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	return values
}

func redactInstallScriptText(text string, values []string) string {
	for _, v := range values {
		text = strings.ReplaceAll(text, v, "[redacted]")
	}
	return text
}

// runInstallScript runs s and returns its report for the result map, or a
// failed CommandResult when it did not succeed. installDir / installFile are
// the agent-owned parameters; secrets are replaced with [redacted] in
// everything captured (installScriptRedactions).
func runInstallScript(s *installScript, run InstallScriptRunner, runID, installDir, installFile string, secrets []string, startTime time.Time) (map[string]any, *CommandResult) {
	params := make(map[string]string, len(s.parameters)+2)
	for k, v := range s.parameters {
		params[k] = v
	}
	params[installScriptParamDir] = installDir
	params[installScriptParamFile] = installFile

	began := time.Now()
	res, runErr := run(InstallScriptRequest{
		ID:             runID + "-" + s.phase,
		ScriptType:     s.language,
		Script:         s.content,
		Parameters:     params,
		TimeoutSeconds: int(s.timeout / time.Second),
	})
	durationMs := time.Since(began).Milliseconds()
	if res == nil {
		res = &InstallScriptResult{ExitCode: -1}
		if runErr != nil {
			res.Error = runErr.Error()
		}
	}

	output := res.Stdout
	if res.Stderr != "" {
		if output != "" && !strings.HasSuffix(output, "\n") {
			output += "\n"
		}
		output += res.Stderr
	}
	output, truncated := sanitizeInstallerOutput(redactInstallScriptText(output, secrets))
	truncated = truncated || res.Truncated

	report := map[string]any{
		"exitCode":   res.ExitCode,
		"output":     output,
		"durationMs": durationMs,
	}
	if truncated {
		report["outputTruncated"] = true
	}

	var code, msg string
	switch {
	case res.TimedOut:
		code = installErrScriptTimeout
		msg = fmt.Sprintf("%s script exceeded %s and was terminated", s.label, s.timeout)
	case runErr != nil:
		code = s.errCode
		msg = fmt.Sprintf("%s script could not run: %s", s.label, redactInstallScriptText(runErr.Error(), secrets))
	case res.Error != "":
		code = s.errCode
		msg = fmt.Sprintf("%s script failed: %s", s.label, redactInstallScriptText(res.Error, secrets))
	case res.ExitCode != 0:
		code = s.errCode
		msg = fmt.Sprintf("%s script exited with code %d", s.label, res.ExitCode)
	default:
		return report, nil
	}

	exitCode := res.ExitCode
	if exitCode == 0 {
		// A refusal that never produced a process still must not read as a
		// clean exit (see CommandResult.ExitCode).
		exitCode = 1
	}
	return report, &CommandResult{
		Status:     "failed",
		ExitCode:   exitCode,
		Stdout:     output,
		Error:      code + ": " + msg,
		DurationMs: time.Since(startTime).Milliseconds(),
	}
}
