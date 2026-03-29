package scripts

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// ---------- NewRunner ----------

func TestNewRunnerCreatesWorkDir(t *testing.T) {
	r := NewRunner()
	if r == nil {
		t.Fatal("NewRunner returned nil")
	}
	if r.workDir == "" {
		t.Fatal("workDir is empty")
	}

	// Verify the directory exists
	info, err := os.Stat(r.workDir)
	if err != nil {
		t.Fatalf("workDir does not exist: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("workDir is not a directory")
	}
}

func TestNewRunnerWorkDirInTempDir(t *testing.T) {
	r := NewRunner()
	expected := filepath.Join(os.TempDir(), "breeze-scripts")
	if r.workDir != expected {
		t.Fatalf("workDir = %q, want %q", r.workDir, expected)
	}
}

// ---------- getExtension ----------

func TestGetExtension(t *testing.T) {
	r := &ScriptRunner{}

	tests := []struct {
		language string
		want     string
	}{
		{"powershell", ".ps1"},
		{"bash", ".sh"},
		{"python", ".py"},
		{"cmd", ".bat"},
		{"unknown", ".sh"},
		{"", ".sh"},
		{"ruby", ".sh"},
		{"javascript", ".sh"},
	}

	for _, tt := range tests {
		t.Run(tt.language, func(t *testing.T) {
			got := r.getExtension(tt.language)
			if got != tt.want {
				t.Fatalf("getExtension(%q) = %q, want %q", tt.language, got, tt.want)
			}
		})
	}
}

// ---------- buildCommand ----------

func TestBuildCommandBash(t *testing.T) {
	r := &ScriptRunner{}
	cmd := r.buildCommand("bash", "/tmp/script.sh")
	if cmd.Path == "" {
		t.Fatal("command path is empty")
	}
	args := cmd.Args
	if len(args) < 2 {
		t.Fatalf("expected at least 2 args, got %d", len(args))
	}
	if args[len(args)-1] != "/tmp/script.sh" {
		t.Fatalf("last arg = %q, want /tmp/script.sh", args[len(args)-1])
	}
}

func TestBuildCommandPython(t *testing.T) {
	r := &ScriptRunner{}
	cmd := r.buildCommand("python", "/tmp/script.py")
	args := cmd.Args
	if len(args) < 2 {
		t.Fatalf("expected at least 2 args, got %d", len(args))
	}
	// Should use python3
	if args[0] != "python3" {
		t.Fatalf("args[0] = %q, want python3", args[0])
	}
}

func TestBuildCommandPowershell(t *testing.T) {
	r := &ScriptRunner{}
	cmd := r.buildCommand("powershell", "/tmp/script.ps1")
	args := cmd.Args

	if runtime.GOOS == "windows" {
		if args[0] != "powershell" {
			t.Fatalf("on windows, args[0] = %q, want powershell", args[0])
		}
	} else {
		if args[0] != "pwsh" {
			t.Fatalf("on non-windows, args[0] = %q, want pwsh", args[0])
		}
	}
}

func TestBuildCommandCmd(t *testing.T) {
	r := &ScriptRunner{}
	cmd := r.buildCommand("cmd", "/tmp/script.bat")
	args := cmd.Args
	if args[0] != "cmd" {
		t.Fatalf("args[0] = %q, want cmd", args[0])
	}
}

func TestBuildCommandDefault(t *testing.T) {
	r := &ScriptRunner{}
	cmd := r.buildCommand("unknown_language", "/tmp/script.sh")
	args := cmd.Args
	if args[0] != "sh" {
		t.Fatalf("args[0] = %q, want sh", args[0])
	}
}

// ---------- Run — basic script execution ----------

func TestRunBashEchoScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", "echo hello world", 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (error: %s)", result.Status, result.ErrorMsg)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exitCode = %d, want 0", result.ExitCode)
	}
	if result.Stdout != "hello world\n" {
		t.Fatalf("stdout = %q, want %q", result.Stdout, "hello world\n")
	}
	if result.DurationMs <= 0 {
		t.Fatal("durationMs should be > 0")
	}
}

func TestRunBashStderrCapture(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", "echo error_msg >&2", 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed", result.Status)
	}
	if result.Stderr != "error_msg\n" {
		t.Fatalf("stderr = %q, want %q", result.Stderr, "error_msg\n")
	}
}

// ---------- Run — non-zero exit code ----------

func TestRunNonZeroExitCode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", "exit 42", 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (non-zero exit is still completed)", result.Status)
	}
	if result.ExitCode != 42 {
		t.Fatalf("exitCode = %d, want 42", result.ExitCode)
	}
}

// ---------- Run — timeout ----------

func TestRunTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", "sleep 30", 200*time.Millisecond)

	if result.Status != "timeout" {
		t.Fatalf("status = %q, want timeout", result.Status)
	}
	if result.ErrorMsg == "" {
		t.Fatal("expected non-empty error message on timeout")
	}
}

// ---------- Run — script cleanup ----------

func TestRunCleansUpTempFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()

	// List files before
	beforeFiles, _ := os.ReadDir(r.workDir)
	beforeCount := len(beforeFiles)

	r.Run("bash", "echo cleanup_test", 10*time.Second)

	// List files after — temp file should be cleaned up
	afterFiles, _ := os.ReadDir(r.workDir)
	afterCount := len(afterFiles)

	if afterCount > beforeCount {
		t.Fatalf("temp file not cleaned up: before=%d, after=%d files", beforeCount, afterCount)
	}
}

// ---------- Run — empty script ----------

func TestRunEmptyScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", "", 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed for empty script", result.Status)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exitCode = %d, want 0 for empty script", result.ExitCode)
	}
}

// ---------- Run — multi-line script ----------

func TestRunMultiLineScript(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	script := `
VAR="hello"
echo "$VAR world"
echo "line2"
`
	result := r.Run("bash", script, 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (error: %s)", result.Status, result.ErrorMsg)
	}
	if result.Stdout != "hello world\nline2\n" {
		t.Fatalf("stdout = %q, want %q", result.Stdout, "hello world\nline2\n")
	}
}

// ---------- Run — sh (default language) ----------

func TestRunDefaultLanguage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping sh test on Windows")
	}

	r := NewRunner()
	result := r.Run("", "echo default_shell", 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed", result.Status)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exitCode = %d, want 0", result.ExitCode)
	}
}

// ---------- ScriptResult struct ----------

func TestScriptResultFieldsPopulated(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", "echo out; echo err >&2; exit 1", 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed", result.Status)
	}
	if result.ExitCode != 1 {
		t.Fatalf("exitCode = %d, want 1", result.ExitCode)
	}
	if result.Stdout != "out\n" {
		t.Fatalf("stdout = %q, want %q", result.Stdout, "out\n")
	}
	if result.Stderr != "err\n" {
		t.Fatalf("stderr = %q, want %q", result.Stderr, "err\n")
	}
	if result.DurationMs <= 0 {
		t.Fatal("durationMs should be > 0")
	}
	if result.ErrorMsg != "" {
		t.Fatalf("errorMsg should be empty for completed scripts, got %q", result.ErrorMsg)
	}
}

// ---------- Run — unwritable workDir ----------

func TestRunUnwritableWorkDir(t *testing.T) {
	r := &ScriptRunner{workDir: "/nonexistent/path/breeze-scripts-test"}
	result := r.Run("bash", "echo fail", 10*time.Second)

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed for unwritable workDir", result.Status)
	}
	if result.ErrorMsg == "" {
		t.Fatal("expected non-empty error message")
	}
	if result.DurationMs < 0 {
		t.Fatalf("durationMs = %d, should be >= 0", result.DurationMs)
	}
}

// ---------- Run — concurrent execution ----------

func TestRunConcurrentScripts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	done := make(chan *ScriptResult, 5)

	for i := 0; i < 5; i++ {
		go func(n int) {
			result := r.Run("bash", "echo concurrent", 10*time.Second)
			done <- result
		}(i)
	}

	for i := 0; i < 5; i++ {
		result := <-done
		if result.Status != "completed" {
			t.Fatalf("concurrent script %d: status = %q, want completed (error: %s)",
				i, result.Status, result.ErrorMsg)
		}
	}
}

// ---------- Run — script with special characters ----------

func TestRunScriptWithSpecialCharacters(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("skipping bash test on Windows")
	}

	r := NewRunner()
	result := r.Run("bash", `echo "hello 'world' & <tag> \"quoted\""`, 10*time.Second)

	if result.Status != "completed" {
		t.Fatalf("status = %q, want completed (error: %s)", result.Status, result.ErrorMsg)
	}
	if result.ExitCode != 0 {
		t.Fatalf("exitCode = %d, want 0", result.ExitCode)
	}
}
