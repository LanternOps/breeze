package executor

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ScriptType constants
const (
	ScriptTypePowerShell = "powershell"
	ScriptTypeBash       = "bash"
	ScriptTypePython     = "python"
	ScriptTypeCMD        = "cmd"
)

// GetShellCommand returns the shell executable and arguments for a given script type
func GetShellCommand(scriptType string) (string, []string) {
	switch strings.ToLower(scriptType) {
	case ScriptTypePowerShell:
		if runtime.GOOS == "windows" {
			return "powershell.exe", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}
		}
		// For Linux/macOS, try pwsh (PowerShell Core)
		return "pwsh", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}

	case ScriptTypeBash:
		if runtime.GOOS == "windows" {
			// Try Git Bash or WSL bash
			return "bash.exe", []string{}
		}
		return "/bin/bash", []string{}

	case ScriptTypePython:
		if runtime.GOOS == "windows" {
			return "python", []string{}
		}
		// Try python3 first on Unix systems
		return "python3", []string{}

	case ScriptTypeCMD:
		if runtime.GOOS == "windows" {
			return "cmd.exe", []string{"/C"}
		}
		// CMD is Windows-only, return empty for other platforms
		return "", nil

	default:
		// Default to bash on Unix, cmd on Windows
		if runtime.GOOS == "windows" {
			return "cmd.exe", []string{"/C"}
		}
		return "/bin/bash", []string{}
	}
}

// GetScriptExtension returns the appropriate file extension for a script type
func GetScriptExtension(scriptType string) string {
	switch strings.ToLower(scriptType) {
	case ScriptTypePowerShell:
		return ".ps1"
	case ScriptTypeBash:
		return ".sh"
	case ScriptTypePython:
		return ".py"
	case ScriptTypeCMD:
		return ".bat"
	default:
		if runtime.GOOS == "windows" {
			return ".bat"
		}
		return ".sh"
	}
}

// WriteScriptFile writes script content to a temporary file with the appropriate extension
func WriteScriptFile(content, scriptType string) (string, error) {
	// Get the temp directory
	tempDir := os.TempDir()
	scriptDir := filepath.Join(tempDir, "breeze-scripts")

	// Create the script directory if it doesn't exist
	if err := os.MkdirAll(scriptDir, 0700); err != nil {
		return "", fmt.Errorf("failed to create script directory: %w", err)
	}

	// Generate a unique filename
	ext := GetScriptExtension(scriptType)
	filename := fmt.Sprintf("breeze_%s%s", generateUniqueID(), ext)
	scriptPath := filepath.Join(scriptDir, filename)

	// Determine file permissions based on OS
	var perm os.FileMode = 0600
	if runtime.GOOS != "windows" {
		perm = 0700 // Executable on Unix
	}

	// Write the script content
	if err := os.WriteFile(scriptPath, []byte(content), perm); err != nil {
		return "", fmt.Errorf("failed to write script file: %w", err)
	}

	return scriptPath, nil
}

// CleanupScript removes a script file from disk
func CleanupScript(path string) {
	if path == "" {
		return
	}

	// Verify the path is in the expected temp directory for safety
	tempDir := os.TempDir()
	scriptDir := filepath.Join(tempDir, "breeze-scripts")

	// Ensure the path is within our script directory
	absPath, err := filepath.Abs(path)
	if err != nil {
		return
	}

	if !strings.HasPrefix(absPath, scriptDir) {
		return
	}

	// Remove the file
	_ = os.Remove(path)
}

// SubstituteParameters replaces parameter placeholders in script content
// Placeholders are in the format {{paramName}} or ${{paramName}}
func SubstituteParameters(content string, params map[string]string) string {
	if params == nil {
		return content
	}

	result := content
	for key, value := range params {
		// Replace both {{key}} and ${{key}} formats
		placeholder1 := fmt.Sprintf("{{%s}}", key)
		placeholder2 := fmt.Sprintf("${{%s}}", key)

		result = strings.ReplaceAll(result, placeholder1, value)
		result = strings.ReplaceAll(result, placeholder2, value)
	}

	return result
}

// generateUniqueID creates a unique identifier for script files
func generateUniqueID() string {
	b := make([]byte, 8)
	_, err := rand.Read(b)
	if err != nil {
		// Fallback to timestamp-based ID if crypto/rand fails
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

// IsSupportedScriptType checks if a script type is supported
func IsSupportedScriptType(scriptType string) bool {
	switch strings.ToLower(scriptType) {
	case ScriptTypePowerShell, ScriptTypeBash, ScriptTypePython, ScriptTypeCMD:
		return true
	default:
		return false
	}
}

// IsScriptTypeAvailableOnPlatform checks if a script type can run on the current platform
func IsScriptTypeAvailableOnPlatform(scriptType string) bool {
	switch strings.ToLower(scriptType) {
	case ScriptTypePowerShell:
		// PowerShell is available on all platforms (pwsh on Linux/macOS)
		return true
	case ScriptTypeBash:
		// Bash might be available on Windows via Git Bash or WSL
		return true
	case ScriptTypePython:
		// Python can be installed on any platform
		return true
	case ScriptTypeCMD:
		// CMD is Windows-only
		return runtime.GOOS == "windows"
	default:
		return false
	}
}
