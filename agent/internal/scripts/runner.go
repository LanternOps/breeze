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

	// Build command
	cmd := r.buildCommand(language, scriptFile)

	// Set up output capture
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	// Start the command
	if err := cmd.Start(); err != nil {
		result.Status = "failed"
		result.ErrorMsg = fmt.Sprintf("Failed to start script: %v", err)
		result.DurationMs = time.Since(start).Milliseconds()
		return result
	}

	// Wait with timeout
	done := make(chan error)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case <-ctx.Done():
		cmd.Process.Kill()
		result.Status = "timeout"
		result.ErrorMsg = "Script execution timed out"
	case err := <-done:
		if err != nil {
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

func (r *ScriptRunner) buildCommand(language, scriptFile string) *exec.Cmd {
	switch language {
	case "powershell":
		if runtime.GOOS == "windows" {
			return exec.Command("powershell", "-ExecutionPolicy", "Bypass", "-File", scriptFile)
		}
		return exec.Command("pwsh", "-File", scriptFile)
	case "bash":
		return exec.Command("bash", scriptFile)
	case "python":
		return exec.Command("python3", scriptFile)
	case "cmd":
		return exec.Command("cmd", "/c", scriptFile)
	default:
		return exec.Command("sh", scriptFile)
	}
}
