package procoutput

import (
	"path/filepath"
	"strings"

	"github.com/breeze-rmm/agent/internal/psscript"
)

const powershellUTF8Bootstrap = "[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "

// powershellExitCodeSuffix follows the call to the script on the -Command
// line. Under -Command the process exit code is only 0 or 1 ($? of the last
// statement), so `exit 3010` in the script reached the agent as 1 (#12798).
// After `& 'script'`, $? is false when the script ran `exit` with a non-zero
// code, and $LASTEXITCODE then holds that code as an int, so it is passed on.
// The codes match powershell -File for the same script: `exit N` is N, a
// thrown error never reaches the suffix and the host reports 1, and a script
// that ends without `exit` is 0 even when its last native command failed ($?
// is true then, and a stale $LASTEXITCODE is not reported).
//
// When $? is false and $LASTEXITCODE is not a positive int, the run reports
// 1, as it did before this suffix: a run that failed before does not become
// a success, and a negative code (which Windows would hand Go as a DWORD
// above the server's 32-bit column, and which the server reads as an
// abnormal end rather than the script's answer) stays 1.
const powershellExitCodeSuffix = "; if (-not $?) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -gt 0) { exit $LASTEXITCODE }; exit 1 }"

// ScriptPathEnv is the environment variable a cmd.exe command line reads the
// script path from.
const ScriptPathEnv = "BREEZE_SCRIPT_FILE"

// ScriptCommand is how a script file is started.
type ScriptCommand struct {
	Name string
	Args []string
	// CmdLine, when not empty, is the exact Windows command line to start
	// Name with, and Args is not used. Apply it with SetCmdLine.
	CmdLine string
	// Env lists environment entries the command reads; append them to the
	// process environment.
	Env []string
}

// windowsScriptCommand adjusts how a script is started on Windows so its
// output is UTF-8 before it is captured. PowerShell is started with -Command
// because -File cannot run the bootstrap before the script; powershellExitCodeSuffix
// keeps the script's own exit code.
func windowsScriptCommand(shellCmd string, shellArgs []string, scriptPath string) ScriptCommand {
	switch strings.ToLower(filepath.Base(shellCmd)) {
	case "powershell.exe", "pwsh.exe":
		return ScriptCommand{Name: shellCmd, Args: []string{
			"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			powershellUTF8Bootstrap + "& " + psscript.Quote(scriptPath) + powershellExitCodeSuffix,
		}}
	case "cmd.exe":
		return cmdScriptCommand(shellCmd, shellArgs, scriptPath)
	default:
		return ScriptCommand{Name: shellCmd, Args: append(append([]string{}, shellArgs...), scriptPath)}
	}
}

// cmdScriptCommand runs chcp and then the batch file in one cmd.exe. The
// command line is built here and passed verbatim (SysProcAttr.CmdLine): Go's
// argument quoting writes inner quotes as \", which cmd.exe does not read,
// and the path needs quotes when it contains spaces or & ^ ( ). The path
// itself is not written into the line: cmd.exe expands %NAME% anywhere in
// it, quoted or not, so it is read from ScriptPathEnv instead.
//
//   - /D skips the AutoRun commands from the registry, so nothing runs
//     before the script but the line below.
//   - With /V:ON (delayed expansion, used for rendered parameters) the path
//     is read as !NAME!, which is expanded once and not re-scanned.
//   - Otherwise it is read as %NAME%. If delayed expansion is on by registry
//     default, cmd.exe would then also process any ! in the expanded path,
//     so a path containing ! is run with /V:OFF. Other paths leave the
//     host's default alone.
//   - /S makes cmd.exe strip exactly the outer pair of quotes.
func cmdScriptCommand(shellCmd string, shellArgs []string, scriptPath string) ScriptCommand {
	flags := shellArgs
	if n := len(flags); n > 0 && strings.EqualFold(flags[n-1], "/C") {
		flags = flags[:n-1]
	}
	delayed := false
	for _, f := range flags {
		if strings.EqualFold(f, "/V:ON") {
			delayed = true
		}
	}
	ref := "%" + ScriptPathEnv + "%"
	if delayed {
		ref = "!" + ScriptPathEnv + "!"
	}
	name := shellCmd
	if strings.ContainsAny(name, " \t") {
		name = `"` + name + `"`
	}
	parts := append([]string{name, "/D"}, flags...)
	if !delayed && strings.Contains(scriptPath, "!") {
		parts = append(parts, "/V:OFF")
	}
	parts = append(parts, "/S", "/C", `"chcp 65001 >nul & "`+ref+`""`)
	return ScriptCommand{
		Name:    shellCmd,
		CmdLine: strings.Join(parts, " "),
		Env:     []string{ScriptPathEnv + "=" + scriptPath},
	}
}
