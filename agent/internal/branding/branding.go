// Package branding holds the display strings an operator can supply at build
// time, so an MSP's own name can appear in the places users read (service
// display names and descriptions, command help text) without patching source.
//
// Every variable is a plain string set through
//
//	-ldflags "-X github.com/breeze-rmm/agent/internal/branding.<Name>=<value>"
//
// (-X only works on plain string variables, so there is no atomic snapshot
// here, unlike hostpolicy). All of them are EMPTY by default: an empty value
// means "this call site keeps its own default", which is what keeps official
// output identical to today's. Use Or to apply that rule.
//
// Display strings only. Anything the agent, the updater, the MSI or the API
// identify by name (service names, binary names, paths, IPC names) is NOT
// brandable; the fixed service names are exported below as constants.
package branding

import (
	"strings"
	"unicode/utf8"
)

// Fixed service names. These are identifiers, not display strings.
const (
	AgentServiceName    = "BreezeAgent"
	WatchdogServiceName = "BreezeWatchdog"
)

// MaxLen is the longest accepted branding value, in characters. Windows caps
// service display names at 256 characters.
const MaxLen = 256

// Operator-supplied display strings. Empty means "use the call site default".
var (
	AgentServiceDisplayName    string
	AgentServiceDescription    string
	WatchdogServiceDisplayName string
	WatchdogServiceDescription string
	AgentCLIShort              string
	WatchdogCLIShort           string
)

// Or returns value, or fallback when value is empty or blank.
func Or(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// Valid reports whether value is safe to use as a branding string. The empty
// string is valid (it means "unset"). Rejected: values longer than MaxLen
// characters, control characters (a newline would inject directives into a
// generated systemd unit), a single quote or backslash (they break the quoting
// used to pass the value through -ldflags), a double quote (PowerShell drops it on
// the way to wix, so an MSI would carry altered text), and '%' (systemd expands
// it as a specifier inside Description=).
func Valid(value string) bool {
	if utf8.RuneCountInString(value) > MaxLen {
		return false
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return false
		}
		if r == '\'' || r == '\\' || r == '%' || r == '"' {
			return false
		}
	}
	return true
}
