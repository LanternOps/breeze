package executor

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/breeze-rmm/agent/internal/obfuscate"
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

		// Credential access patterns. These three tool-name tokens are stored
		// XOR-obfuscated (see internal/obfuscate) so they never appear as
		// plaintext in shipped binaries, where AV heuristics match on them
		// (issue #2797). The tokens contain no regex metacharacters, so
		// decoding them straight into the pattern preserves matching semantics.
		{obfuscate.Decode([]byte{0x37, 0x33, 0x37, 0x33, 0x31, 0x3b, 0x2e, 0x20}), "credential dumping tool"},
		{obfuscate.Decode([]byte{0x29, 0x3f, 0x31, 0x2f, 0x28, 0x36, 0x29, 0x3b}), "credential extraction"},
		{obfuscate.Decode([]byte{0x36, 0x29, 0x3b, 0x3e, 0x2f, 0x37, 0x2a}), "LSA dump"},
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
			log.Warn("failed to compile security pattern", "pattern", p.pattern, "error", err)
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
			log.Warn("failed to compile security pattern", "pattern", p.pattern, "error", err)
			continue
		}
		v.patterns = append(v.patterns, &dangerPattern{
			regex:       regex,
			description: p.desc,
			level:       SecurityLevelStrict,
		})
	}
}

// Validate checks the script content for dangerous patterns, with no
// acknowledgements. Equivalent to ValidateWithAcknowledgements(content, nil).
func (v *SecurityValidator) Validate(content string) error {
	return v.ValidateWithAcknowledgements(content, nil)
}

// ValidateWithAcknowledgements checks the script content for dangerous
// patterns, allowing STRICT-level patterns whose description appears in
// acknowledged (#5129).
//
// The two levels are deliberately asymmetric:
//
//   - BASIC patterns (`rm -rf /`, `Format-Volume`, fork bombs, block-device
//     writes) are unconditional. There is no legitimate RMM use for them, so
//     they are never acknowledgeable and no value of `acknowledged` can permit
//     one. An acknowledgement naming a basic description is simply ignored.
//   - STRICT patterns are risky-but-legitimate admin work — writing an HKLM
//     value is one of the most common things an MSP tech does on Windows. The
//     server dispatches the set of descriptions an admin explicitly signed off
//     on for THIS script, and exactly those are allowed through.
//
// `acknowledged` carries DESCRIPTIONS, not a blanket "this script is
// approved" flag. That is the whole point: an approval is scoped to the
// specific risk it was granted for, so a later script edit that introduces a
// different pattern is unacknowledged and still blocked, while the original
// approval keeps working.
//
// A nil or empty set is the pre-#5129 behaviour exactly — fail closed. An
// older API that does not send the field therefore cannot loosen a newer
// agent.
func (v *SecurityValidator) ValidateWithAcknowledgements(content string, acknowledged []string) error {
	if v.level == SecurityLevelNone {
		return nil
	}

	acknowledgedSet := newAcknowledgementSet(acknowledged)

	// Check each pattern. Basic patterns are registered first, so a script
	// that trips both levels always reports the unconditional one.
	for _, p := range v.patterns {
		if p.level > v.level {
			continue
		}

		if !p.regex.MatchString(content) {
			continue
		}

		if p.level == SecurityLevelBasic {
			return fmt.Errorf(
				"potentially dangerous pattern detected: %s. This pattern is blocked on every device and cannot be overridden; rewrite the script so it does not match",
				p.description)
		}

		if _, ok := acknowledgedSet[p.description]; ok {
			continue
		}

		return fmt.Errorf(
			"potentially dangerous pattern detected: %s. If the script is meant to do this, open it in Breeze (Scripts → edit the script) and acknowledge %q under Security review, then run it again. For a one-off change on a single device use Remote Tools (Registry or Terminal) instead",
			p.description, p.description)
	}

	return nil
}

// newAcknowledgementSet indexes the dispatched descriptions for lookup.
//
// Entries are trimmed because the value survives a JSON round trip and an
// IPC hop, and losing a legitimate acknowledgement to stray whitespace is a
// pure availability bug. Matching is otherwise EXACT — no case folding — so
// an acknowledgement can only ever name a description the agent itself
// produced.
func newAcknowledgementSet(acknowledged []string) map[string]struct{} {
	if len(acknowledged) == 0 {
		return nil
	}
	set := make(map[string]struct{}, len(acknowledged))
	for _, description := range acknowledged {
		trimmed := strings.TrimSpace(description)
		if trimmed == "" {
			continue
		}
		set[trimmed] = struct{}{}
	}
	return set
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
		// Private keys — remove the ENTIRE PEM block (header + base64 body + footer),
		// not just the header line, or the key stays fully reconstructable. The
		// algorithm token is optional so PKCS#8 `-----BEGIN PRIVATE KEY-----`
		// is covered alongside RSA/EC/DSA/OPENSSH/ENCRYPTED forms. `(?s)` lets `.`
		// match newlines; the non-greedy `.*?` stops at the first END marker so two
		// separate keys are each redacted individually. (RE2 has no backreferences,
		// so the header/footer algorithm tokens are matched independently.)
		{regexp.MustCompile(`(?s)-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----`), "[PRIVATE_KEY_REDACTED]"},
		// Truncated private key fallback — a key cut off between header and footer
		// (output caps, killed process) has a BEGIN line and a full base64 body but
		// no END marker, so the complete-block rule above matches nothing and the
		// body leaks verbatim. This rule strips a lone BEGIN header plus any
		// immediately-following base64/whitespace body. It MUST run AFTER the
		// complete-block rule: that pass replaces whole keys (END marker included)
		// with the marker text first, so this fallback finds no remaining BEGIN
		// header for a complete key and can only catch genuinely truncated ones.
		// RE2 is linear (no catastrophic backtracking), so the greedy `*` is safe.
		{regexp.MustCompile(`-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[A-Za-z0-9+/=\s]*`), "[PRIVATE_KEY_REDACTED]"},
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
