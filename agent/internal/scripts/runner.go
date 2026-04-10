// Deprecated: Use github.com/breeze-rmm/agent/internal/executor instead.
// The executor package provides security validation, output size limits,
// cancellation, parameter substitution, and runAs support.
package scripts

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

type ScriptResult struct {
	Status      string `json:"status"`
	ExitCode    int    `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	DurationMs  int64  `json:"durationMs"`
	ErrorMsg    string `json:"errorMessage,omitempty"`
}

type ScriptRunner struct {
	workDir string
}

func NewRunner() *ScriptRunner {
	workDir := filepath.Join(os.TempDir(), "breeze-scripts")
	os.MkdirAll(workDir, 0755)
	return &ScriptRunner{workDir: workDir}
}

func (r *ScriptRunner) Run(language, content string, timeout time.Duration) *ScriptResult {
	result := &ScriptResult{}
	start := time.Now()

	// Create temp script file
	ext := r.getExtension(language)
	scriptFile := filepath.Join(r.workDir, fmt.Sprintf("script_%d%s", time.Now().UnixNano(), ext))

	if err := os.WriteFile(scriptFile, []byte(content), 0755); err != nil {
		result.Status = "failed"
		result.ErrorMsg = fmt.Sprintf("Failed to write script: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result
	}
	defer os.Remove(scriptFile)

	// Create context with timeout and build command via CommandContext so
	// os/exec handles the kill-on-timeout synchronization for us. Writing to
	// cmd.Process from a separate goroutine while Wait is running is a race.
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := r.buildCommandContext(ctx, language, scriptFile)

	// Set up output capture
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Safety net if the child ignores SIGKILL and leaves pipes open.
	cmd.WaitDelay = 5 * time.Second

	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		result.Status = "timeout"
		result.ErrorMsg = "Script execution timed out"
	} else if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			result.Status = "completed"
		} else {
			result.Status = "failed"
			result.ErrorMsg = err.Error()
		}
	} else {
		result.Status = "completed"
		result.ExitCode = 0
	}

	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	result.DurationMs = time.Since(start).Milliseconds()

	return result
}

func (r *ScriptRunner) getExtension(language string) string {
	switch language {
	case "powershell":
		return ".ps1"
	case "bash":
		return ".sh"
	case "python":
		return ".py"
	case "cmd":
		return ".bat"
	default:
		return ".sh"
	}
}

// buildCommand constructs an uncontextualized command. Kept for tests that
// inspect the produced argv; production callers should use buildCommandContext
// so timeouts propagate via the context (avoids racing with cmd.Process.Kill).
func (r *ScriptRunner) buildCommand(language, scriptFile string) *exec.Cmd {
	return r.buildCommandContext(context.Background(), language, scriptFile)
}

func (r *ScriptRunner) buildCommandContext(ctx context.Context, language, scriptFile string) *exec.Cmd {
	switch language {
	case "powershell":
		if runtime.GOOS == "windows" {
			return exec.CommandContext(ctx, "powershell", "-ExecutionPolicy", "Bypass", "-File", scriptFile)
		}
		return exec.CommandContext(ctx, "pwsh", "-File", scriptFile)
	case "bash":
		return exec.CommandContext(ctx, "bash", scriptFile)
	case "python":
		return exec.CommandContext(ctx, "python3", scriptFile)
	case "cmd":
		return exec.CommandContext(ctx, "cmd", "/c", scriptFile)
	default:
		return exec.CommandContext(ctx, "sh", scriptFile)
	}
}
