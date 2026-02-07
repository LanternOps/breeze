package executor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("executor")

const (
	// DefaultTimeout is the default execution timeout in seconds
	DefaultTimeout = 300 // 5 minutes

	// MaxTimeout is the maximum allowed execution timeout
	MaxTimeout = 3600 // 1 hour

	// MaxOutputSize is the maximum size of stdout/stderr to capture
	MaxOutputSize = 1024 * 1024 // 1MB
)

// ScriptExecution represents a script to be executed
type ScriptExecution struct {
	ID         string            `json:"id"`
	ScriptID   string            `json:"scriptId"`
	ScriptType string            `json:"scriptType"`
	Script     string            `json:"script"`
	Parameters map[string]string `json:"parameters,omitempty"`
	Timeout    int               `json:"timeout"`
	RunAs      string            `json:"runAs,omitempty"`
}

// ScriptResult represents the result of a script execution
type ScriptResult struct {
	ExecutionID string `json:"executionId"`
	ExitCode    int    `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	Error       string `json:"error,omitempty"`
	StartedAt   string `json:"startedAt"`
	CompletedAt string `json:"completedAt"`
}

// Executor handles script execution with security controls
type Executor struct {
	config    *config.Config
	workDir   string
	validator *SecurityValidator
	running   map[string]*runningExecution
	mu        sync.Mutex
}

// runningExecution tracks a running script execution
type runningExecution struct {
	cmd        *exec.Cmd
	cancel     context.CancelFunc
	startedAt  time.Time
	scriptType string
}

// New creates a new Executor instance
func New(cfg *config.Config) *Executor {
	workDir := os.TempDir()
	if dir := config.GetDataDir(); dir != "" {
		scriptDir := dir + "/scripts"
		if err := os.MkdirAll(scriptDir, 0700); err == nil {
			workDir = scriptDir
		}
	}

	return &Executor{
		config:    cfg,
		workDir:   workDir,
		validator: NewSecurityValidator(SecurityLevelStrict),
		running:   make(map[string]*runningExecution),
	}
}

// Execute runs a script and returns the result
func (e *Executor) Execute(script ScriptExecution) (*ScriptResult, error) {
	startTime := time.Now()
	result := &ScriptResult{
		ExecutionID: script.ID,
		StartedAt:   startTime.UTC().Format(time.RFC3339),
	}

	log.Info("starting execution", "executionId", script.ID, "scriptId", script.ScriptID, "scriptType", script.ScriptType, "timeout", script.Timeout)

	// Validate script type
	if !IsSupportedScriptType(script.ScriptType) {
		err := fmt.Errorf("unsupported script type: %s", script.ScriptType)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Check platform compatibility
	if !IsScriptTypeAvailableOnPlatform(script.ScriptType) {
		err := fmt.Errorf("script type %s is not available on %s", script.ScriptType, runtime.GOOS)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Substitute parameters first, then validate
	scriptContent := SubstituteParameters(script.Script, script.Parameters)

	// Validate script content for security (after parameter substitution)
	if err := e.validateScript(scriptContent); err != nil {
		log.Warn("script validation failed", "executionId", script.ID, "error", err)
		result.ExitCode = -1
		result.Error = fmt.Sprintf("script validation failed: %v", err)
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Write script to temp file
	scriptPath, err := WriteScriptFile(scriptContent, script.ScriptType)
	if err != nil {
		log.Error("failed to write script file", "executionId", script.ID, "error", err)
		result.ExitCode = -1
		result.Error = fmt.Sprintf("failed to write script: %v", err)
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}
	defer CleanupScript(scriptPath)

	// Determine timeout
	timeout := script.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	if timeout > MaxTimeout {
		timeout = MaxTimeout
	}

	// Create context with timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()

	// Build command
	shellCmd, shellArgs := GetShellCommand(script.ScriptType)
	if shellCmd == "" {
		err := fmt.Errorf("no shell available for script type: %s", script.ScriptType)
		result.ExitCode = -1
		result.Error = err.Error()
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	args := append(shellArgs, scriptPath)
	cmd := exec.CommandContext(ctx, shellCmd, args...)

	// Set working directory
	cmd.Dir = e.workDir

	// Set up output capture with size limits
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: MaxOutputSize}
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: MaxOutputSize}

	// Configure environment
	cmd.Env = e.buildEnvironment(script)

	// Set process group so children are killed on timeout
	setProcessGroup(cmd)

	// Handle runAs for elevated execution
	if script.RunAs != "" {
		if err := e.configureRunAs(cmd, script.RunAs); err != nil {
			log.Error("failed to configure runAs", "executionId", script.ID, "user", script.RunAs, "error", err)
			result.ExitCode = -1
			result.Error = fmt.Sprintf("failed to configure runAs: %v", err)
			result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
			return result, err
		}
	}

	// Track running execution
	e.mu.Lock()
	e.running[script.ID] = &runningExecution{
		cmd:        cmd,
		cancel:     cancel,
		startedAt:  startTime,
		scriptType: script.ScriptType,
	}
	e.mu.Unlock()

	// Execute the script
	err = cmd.Run()

	// Remove from running executions
	e.mu.Lock()
	delete(e.running, script.ID)
	e.mu.Unlock()

	// Process results
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	result.CompletedAt = time.Now().UTC().Format(time.RFC3339)

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			// Kill the entire process group on timeout
			if killErr := killProcessGroup(cmd); killErr != nil {
				log.Warn("failed to kill process group", "executionId", script.ID, "error", killErr)
			}
			log.Warn("execution timed out", "executionId", script.ID, "timeoutSeconds", timeout)
			result.ExitCode = -1
			result.Error = fmt.Sprintf("execution timed out after %d seconds", timeout)
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			log.Info("execution completed", "executionId", script.ID, "exitCode", result.ExitCode)
		} else {
			result.ExitCode = -1
			result.Error = err.Error()
			log.Error("execution failed", "executionId", script.ID, "error", err)
		}
	} else {
		result.ExitCode = 0
		log.Info("execution completed successfully", "executionId", script.ID, "duration", time.Since(startTime))
	}

	return result, nil
}

// Cancel terminates a running script execution
func (e *Executor) Cancel(executionID string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	running, exists := e.running[executionID]
	if !exists {
		return fmt.Errorf("execution %s not found or already completed", executionID)
	}

	log.Info("cancelling execution", "executionId", executionID)

	// Cancel the context to terminate the process
	running.cancel()

	// Kill the entire process group to prevent orphaned children
	if err := killProcessGroup(running.cmd); err != nil {
		log.Warn("failed to kill process group", "executionId", executionID, "error", err)
	}

	return nil
}

// ListRunning returns a list of currently running execution IDs
func (e *Executor) ListRunning() []string {
	e.mu.Lock()
	defer e.mu.Unlock()

	ids := make([]string, 0, len(e.running))
	for id := range e.running {
		ids = append(ids, id)
	}
	return ids
}

// GetRunningCount returns the number of currently running executions
func (e *Executor) GetRunningCount() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.running)
}

// validateScript performs security validation on script content
func (e *Executor) validateScript(content string) error {
	if content == "" {
		return fmt.Errorf("script content is empty")
	}

	// Check for maximum script size (1MB)
	if len(content) > MaxScriptSize {
		return fmt.Errorf("script content exceeds maximum size of %d bytes", MaxScriptSize)
	}

	// Use the SecurityValidator for comprehensive pattern checking
	return e.validator.Validate(content)
}

// buildEnvironment creates the environment variables for script execution
func (e *Executor) buildEnvironment(script ScriptExecution) []string {
	env := os.Environ()

	// Add Breeze-specific environment variables
	env = append(env,
		"BREEZE_EXECUTION_ID="+script.ID,
		"BREEZE_SCRIPT_ID="+script.ScriptID,
	)

	// Add parameters as environment variables (prefixed)
	for key, value := range script.Parameters {
		envKey := "BREEZE_PARAM_" + strings.ToUpper(strings.ReplaceAll(key, "-", "_"))
		env = append(env, envKey+"="+value)
	}

	return env
}

// configureRunAs configures the command to run as a different user
func (e *Executor) configureRunAs(cmd *exec.Cmd, runAs string) error {
	if runAs == "" {
		return nil
	}

	switch runtime.GOOS {
	case "windows":
		return fmt.Errorf("runAs on Windows is not yet implemented")

	case "linux", "darwin":
		// On Unix systems, we can use sudo
		if runAs == "root" {
			originalPath := cmd.Path
			originalArgs := cmd.Args

			cmd.Path = "/usr/bin/sudo"
			cmd.Args = append([]string{"sudo", "-n"}, originalArgs...)
			cmd.Args[2] = originalPath
		} else {
			cmd.Path = "/usr/bin/sudo"
			originalArgs := cmd.Args
			cmd.Args = append([]string{"sudo", "-n", "-u", runAs}, originalArgs...)
		}
		return nil

	default:
		return fmt.Errorf("runAs not supported on %s", runtime.GOOS)
	}
}

// limitedWriter wraps a buffer with a size limit
type limitedWriter struct {
	buf     *bytes.Buffer
	limit   int
	written int
}

func (w *limitedWriter) Write(p []byte) (n int, err error) {
	if w.written >= w.limit {
		// Discard additional data but don't error
		return len(p), nil
	}

	remaining := w.limit - w.written
	if len(p) > remaining {
		p = p[:remaining]
	}

	n, err = w.buf.Write(p)
	w.written += n
	return len(p), err // Return original length to avoid short write errors
}
