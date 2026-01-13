package executor

import (
	"fmt"
	"regexp"
	"strings"
)

// SecurityLevel defines the level of security validation
type SecurityLevel int

const (
	// SecurityLevelNone disables security validation (not recommended)
	SecurityLevelNone SecurityLevel = iota
	// SecurityLevelBasic performs basic pattern matching
	SecurityLevelBasic
	// SecurityLevelStrict performs strict validation
	SecurityLevelStrict
)

// SecurityValidator validates script content for potentially dangerous operations
type SecurityValidator struct {
	level    SecurityLevel
	patterns []*dangerPattern
}

type dangerPattern struct {
	regex       *regexp.Regexp
	description string
	level       SecurityLevel
}

// NewSecurityValidator creates a new security validator with the specified level
func NewSecurityValidator(level SecurityLevel) *SecurityValidator {
	v := &SecurityValidator{
		level:    level,
		patterns: make([]*dangerPattern, 0),
	}
	v.initPatterns()
	return v
}

// initPatterns initializes the dangerous pattern list
func (v *SecurityValidator) initPatterns() {
	// Basic level patterns - clearly dangerous operations
	basicPatterns := []struct {
		pattern string
		desc    string
	}{
		// Unix dangerous patterns
		{`rm\s+-[rR]f?\s+/\s*$`, "recursive delete on root directory"},
		{`rm\s+-[rR]f?\s+/\*`, "recursive delete on root wildcard"},
		{`rm\s+-[rR]f?\s+/[a-z]+\s*$`, "recursive delete on system directory"},
		{`mkfs\s+`, "filesystem format command"},
		{`dd\s+.*of=/dev/[hs]d`, "direct disk write to block device"},
		{`>\s*/dev/[hs]d`, "redirect to block device"},
		{`chmod\s+-[rR]\s+[0-7]*777\s+/`, "dangerous recursive chmod on root"},
		{`chown\s+-[rR]\s+.*\s+/\s*$`, "dangerous recursive chown on root"},
		{`:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, "fork bomb pattern"},
		{`/dev/null\s*>\s*/etc/passwd`, "attempt to destroy passwd file"},
		{`echo\s+.*>\s*/etc/shadow`, "attempt to modify shadow file"},

		// Windows dangerous patterns
		{`format\s+[a-zA-Z]:`, "disk format command"},
		{`del\s+/[fFsS]\s+[a-zA-Z]:\\Windows`, "Windows system file deletion"},
		{`rd\s+/[sS]\s+/[qQ]\s+[a-zA-Z]:\\Windows`, "Windows directory deletion"},
		{`rd\s+/[sS]\s+/[qQ]\s+[a-zA-Z]:\\Program`, "Program Files deletion"},
		{`attrib\s+.*[a-zA-Z]:\\Windows`, "modify Windows file attributes"},

		// PowerShell dangerous patterns
		{`Remove-Item\s+-Recurse\s+-Force\s+[A-Z]:\\Windows`, "PowerShell Windows deletion"},
		{`Remove-Item\s+-Recurse\s+-Force\s+/`, "PowerShell root deletion"},
		{`Format-Volume`, "PowerShell volume format"},
		{`Clear-Disk`, "PowerShell disk clear"},
		{`Initialize-Disk`, "PowerShell disk initialize"},
	}

	// Strict level patterns - potentially risky operations
	strictPatterns := []struct {
		pattern string
		desc    string
	}{
		// Network exfiltration patterns
		{`curl\s+.*\|\s*bash`, "remote code execution via curl"},
		{`wget\s+.*\|\s*bash`, "remote code execution via wget"},
		{`curl\s+.*\|\s*sh`, "remote code execution via curl"},
		{`wget\s+.*\|\s*sh`, "remote code execution via wget"},
		{`Invoke-WebRequest.*\|\s*Invoke-Expression`, "PowerShell remote execution"},
		{`IEX\s*\(\s*\(New-Object`, "PowerShell download cradle"},
		{`DownloadString\s*\(`, "PowerShell download string"},

		// Credential access patterns
		{`mimikatz`, "credential dumping tool"},
		{`sekurlsa`, "credential extraction"},
		{`lsadump`, "LSA dump"},
		{`Get-Credential`, "PowerShell credential prompt"},
		{`ConvertTo-SecureString`, "PowerShell secure string (may be legitimate)"},

		// Persistence patterns
		{`schtasks\s+/create`, "scheduled task creation"},
		{`at\s+\d+:\d+`, "at job creation"},
		{`crontab\s+-[el]`, "crontab modification"},
		{`Register-ScheduledTask`, "PowerShell scheduled task"},
		{`New-Service`, "PowerShell service creation"},

		// Privilege escalation patterns
		{`setuid`, "setuid manipulation"},
		{`setgid`, "setgid manipulation"},
		{`chmod\s+[0-7]*[4-7][0-7]{2}`, "setuid/setgid chmod"},

		// Registry modification (Windows)
		{`reg\s+add\s+HKLM`, "HKLM registry modification"},
		{`Set-ItemProperty\s+.*HKLM`, "PowerShell HKLM modification"},
		{`New-ItemProperty\s+.*HKLM`, "PowerShell HKLM property creation"},

		// System modification
		{`visudo`, "sudoers modification"},
		{`/etc/sudoers`, "sudoers file access"},
		{`passwd\s+-d`, "password removal"},
		{`usermod\s+-[aG].*sudo`, "sudo group modification"},
		{`net\s+localgroup\s+administrators`, "Windows admin group modification"},
	}

	// Add basic patterns
	for _, p := range basicPatterns {
		regex, err := regexp.Compile("(?i)" + p.pattern)
		if err != nil {
			continue
		}
		v.patterns = append(v.patterns, &dangerPattern{
			regex:       regex,
			description: p.desc,
			level:       SecurityLevelBasic,
		})
	}

	// Add strict patterns
	for _, p := range strictPatterns {
		regex, err := regexp.Compile("(?i)" + p.pattern)
		if err != nil {
			continue
		}
		v.patterns = append(v.patterns, &dangerPattern{
			regex:       regex,
			description: p.desc,
			level:       SecurityLevelStrict,
		})
	}
}

// Validate checks the script content for dangerous patterns
func (v *SecurityValidator) Validate(content string) error {
	if v.level == SecurityLevelNone {
		return nil
	}

	// Check each pattern
	for _, p := range v.patterns {
		if p.level > v.level {
			continue
		}

		if p.regex.MatchString(content) {
			return fmt.Errorf("potentially dangerous pattern detected: %s", p.description)
		}
	}

	return nil
}

// ValidateWithDetails returns all matching dangerous patterns
func (v *SecurityValidator) ValidateWithDetails(content string) []string {
	if v.level == SecurityLevelNone {
		return nil
	}

	var matches []string
	for _, p := range v.patterns {
		if p.level > v.level {
			continue
		}

		if p.regex.MatchString(content) {
			matches = append(matches, p.description)
		}
	}

	return matches
}

// SanitizeOutput removes potentially sensitive information from script output
func SanitizeOutput(output string) string {
	// Patterns to redact
	redactPatterns := []struct {
		regex       *regexp.Regexp
		replacement string
	}{
		// API keys and tokens
		{regexp.MustCompile(`(?i)(api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*[=:]\s*['"]?[a-zA-Z0-9_\-]{8,}['"]?`), "$1=[REDACTED]"},
		// AWS keys
		{regexp.MustCompile(`(?i)AKIA[0-9A-Z]{16}`), "[AWS_KEY_REDACTED]"},
		// Private keys
		{regexp.MustCompile(`-----BEGIN [A-Z]+ PRIVATE KEY-----`), "[PRIVATE_KEY_REDACTED]"},
		// Connection strings
		{regexp.MustCompile(`(?i)(mongodb|mysql|postgresql|redis|amqp)://[^\s]+`), "$1://[CONNECTION_STRING_REDACTED]"},
		// Bearer tokens
		{regexp.MustCompile(`(?i)bearer\s+[a-zA-Z0-9_\-\.]+`), "Bearer [TOKEN_REDACTED]"},
		// JWT tokens
		{regexp.MustCompile(`eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*`), "[JWT_REDACTED]"},
	}

	result := output
	for _, p := range redactPatterns {
		result = p.regex.ReplaceAllString(result, p.replacement)
	}

	return result
}

// IsPathSafe checks if a file path is within allowed boundaries
func IsPathSafe(path string, allowedPaths []string) bool {
	// Normalize the path
	normalizedPath := strings.ToLower(strings.ReplaceAll(path, "\\", "/"))

	// Check against allowed paths
	for _, allowed := range allowedPaths {
		normalizedAllowed := strings.ToLower(strings.ReplaceAll(allowed, "\\", "/"))
		if strings.HasPrefix(normalizedPath, normalizedAllowed) {
			return true
		}
	}

	return false
}

// ContainsSensitiveInfo checks if content might contain sensitive information
func ContainsSensitiveInfo(content string) bool {
	sensitivePatterns := []string{
		`(?i)password`,
		`(?i)secret`,
		`(?i)api[_-]?key`,
		`(?i)private[_-]?key`,
		`(?i)access[_-]?token`,
		`(?i)bearer`,
		`(?i)credential`,
	}

	for _, pattern := range sensitivePatterns {
		regex, err := regexp.Compile(pattern)
		if err != nil {
			continue
		}
		if regex.MatchString(content) {
			return true
		}
	}

	return false
}
