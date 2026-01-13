package executor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/pkg/models"
)

const (
	// DefaultTimeout is the default execution timeout in seconds
	DefaultTimeout = 300 // 5 minutes

	// MaxTimeout is the maximum allowed execution timeout
	MaxTimeout = 3600 // 1 hour

	// MaxOutputSize is the maximum size of stdout/stderr to capture
	MaxOutputSize = 1024 * 1024 // 1MB
)

// Executor handles script execution with security controls
type Executor struct {
	config  *config.Config
	workDir string
	running map[string]*runningExecution
	mu      sync.Mutex
	logger  *zap.Logger
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
	logger, _ := zap.NewProduction()

	// Determine work directory
	workDir := os.TempDir()
	if dir := config.GetDataDir(); dir != "" {
		scriptDir := dir + "/scripts"
		if err := os.MkdirAll(scriptDir, 0700); err == nil {
			workDir = scriptDir
		}
	}

	return &Executor{
		config:  cfg,
		workDir: workDir,
		running: make(map[string]*runningExecution),
		logger:  logger,
	}
}

// NewWithLogger creates a new Executor instance with a custom logger
func NewWithLogger(cfg *config.Config, logger *zap.Logger) *Executor {
	workDir := os.TempDir()
	if dir := config.GetDataDir(); dir != "" {
		scriptDir := dir + "/scripts"
		if err := os.MkdirAll(scriptDir, 0700); err == nil {
			workDir = scriptDir
		}
	}

	return &Executor{
		config:  cfg,
		workDir: workDir,
		running: make(map[string]*runningExecution),
		logger:  logger,
	}
}

// Execute runs a script and returns the result
func (e *Executor) Execute(script models.ScriptExecution) (*models.ScriptResult, error) {
	startTime := time.Now()
	result := &models.ScriptResult{
		ExecutionID: script.ID,
		StartedAt:   startTime.UTC().Format(time.RFC3339),
	}

	e.logger.Info("Starting script execution",
		zap.String("execution_id", script.ID),
		zap.String("script_id", script.ScriptID),
		zap.String("script_type", script.ScriptType),
		zap.Int("timeout", script.Timeout),
	)

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

	// Validate script content for security
	if err := e.validateScript(script.Script); err != nil {
		e.logger.Warn("Script validation failed",
			zap.String("execution_id", script.ID),
			zap.Error(err),
		)
		result.ExitCode = -1
		result.Error = fmt.Sprintf("script validation failed: %v", err)
		result.CompletedAt = time.Now().UTC().Format(time.RFC3339)
		return result, err
	}

	// Substitute parameters
	scriptContent := SubstituteParameters(script.Script, script.Parameters)

	// Write script to temp file
	scriptPath, err := WriteScriptFile(scriptContent, script.ScriptType)
	if err != nil {
		e.logger.Error("Failed to write script file",
			zap.String("execution_id", script.ID),
			zap.Error(err),
		)
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

	// Handle runAs for elevated execution
	if script.RunAs != "" {
		if err := e.configureRunAs(cmd, script.RunAs); err != nil {
			e.logger.Warn("Failed to configure runAs",
				zap.String("execution_id", script.ID),
				zap.String("runAs", script.RunAs),
				zap.Error(err),
			)
			// Continue without runAs, but log the warning
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
			e.logger.Warn("Script execution timed out",
				zap.String("execution_id", script.ID),
				zap.Int("timeout", timeout),
			)
			result.ExitCode = -1
			result.Error = fmt.Sprintf("execution timed out after %d seconds", timeout)
		} else if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			e.logger.Info("Script execution completed with error",
				zap.String("execution_id", script.ID),
				zap.Int("exit_code", result.ExitCode),
			)
		} else {
			result.ExitCode = -1
			result.Error = err.Error()
			e.logger.Error("Script execution failed",
				zap.String("execution_id", script.ID),
				zap.Error(err),
			)
		}
	} else {
		result.ExitCode = 0
		e.logger.Info("Script execution completed successfully",
			zap.String("execution_id", script.ID),
			zap.Duration("duration", time.Since(startTime)),
		)
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

	e.logger.Info("Cancelling script execution",
		zap.String("execution_id", executionID),
	)

	// Cancel the context to terminate the process
	running.cancel()

	// On Windows, we may need to forcefully kill the process
	if runtime.GOOS == "windows" && running.cmd.Process != nil {
		_ = running.cmd.Process.Kill()
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
	if len(content) > MaxOutputSize {
		return fmt.Errorf("script content exceeds maximum size of %d bytes", MaxOutputSize)
	}

	// Define patterns that may indicate malicious content
	// These are heuristic checks and not foolproof
	dangerousPatterns := []struct {
		pattern string
		desc    string
	}{
		// Format string operations that could be used maliciously
		{`rm\s+-rf\s+/\s*$`, "dangerous recursive delete on root"},
		{`rm\s+-rf\s+/\*`, "dangerous recursive delete on root wildcard"},
		{`mkfs\.`, "filesystem format command"},
		{`dd\s+if=.*of=/dev/`, "direct disk write"},
		{`chmod\s+-R\s+777\s+/`, "dangerous recursive chmod on root"},
		{`:(){ :|:& };:`, "fork bomb"},
		// Windows-specific dangerous patterns
		{`format\s+[a-zA-Z]:`, "disk format command"},
		{`del\s+/[fqs]\s+[a-zA-Z]:\\Windows`, "Windows system file deletion"},
		{`rd\s+/s\s+/q\s+[a-zA-Z]:\\Windows`, "Windows system directory deletion"},
	}

	contentLower := strings.ToLower(content)
	for _, dp := range dangerousPatterns {
		matched, err := regexp.MatchString(dp.pattern, contentLower)
		if err != nil {
			continue
		}
		if matched {
			return fmt.Errorf("script contains potentially dangerous pattern: %s", dp.desc)
		}
	}

	return nil
}

// buildEnvironment creates the environment variables for script execution
func (e *Executor) buildEnvironment(script models.ScriptExecution) []string {
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
		// On Windows, we would need to use runas or similar
		// This is complex and requires additional handling
		e.logger.Debug("runAs on Windows requires additional configuration",
			zap.String("runAs", runAs),
		)
		return fmt.Errorf("runAs on Windows is not yet implemented")

	case "linux", "darwin":
		// On Unix systems, we can use sudo
		// Note: This requires proper sudoers configuration
		if runAs == "root" {
			// Wrap the command with sudo
			originalPath := cmd.Path
			originalArgs := cmd.Args

			cmd.Path = "/usr/bin/sudo"
			cmd.Args = append([]string{"sudo", "-n"}, originalArgs...)
			cmd.Args[2] = originalPath

			e.logger.Debug("Configured runAs with sudo",
				zap.String("runAs", runAs),
			)
		} else {
			// Run as specific user
			cmd.Path = "/usr/bin/sudo"
			originalArgs := cmd.Args
			cmd.Args = append([]string{"sudo", "-n", "-u", runAs}, originalArgs...)

			e.logger.Debug("Configured runAs with sudo -u",
				zap.String("runAs", runAs),
			)
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
