package agentapp

import (
	"errors"
	"regexp"
)

// errNoFilenameToken is returned when a filename carries no (TOKEN@HOST) /
// [TOKEN@HOST] group.
var errNoFilenameToken = errors.New("no bootstrap token in installer filename")

// installerTokenParenRe is the canonical Windows form: a 10-char base36 token
// and a host wrapped in PARENTHESES. The Windows MSI download filename uses
// parens (not brackets) because the path travels through MSI's Formatted-field
// engine — [OriginalDatabase] is formatted directly into the BootstrapEnroll
// deferred CA's command line (agent bootstrap --install-data) — and a "[...]"
// substring (brackets are that engine's property-reference delimiter) gets
// stripped along the way, silently dropping the token (observed in #1956).
// Parens are not special in MSI Formatted fields, so they survive intact.
var installerTokenParenRe = regexp.MustCompile(`\(([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\)`)

// installerTokenBracketRe is the legacy form: [TOKEN@HOST] in square brackets
// (mirrors FilenameTokenParser.swift). The current macOS path carries the token
// in an embedded bootstrap.json (no filename delimiter); the bracketed .app
// bundle name only appears under the opt-in MACOS_INSTALLER_FILENAME_TOKEN_COMPAT
// mode. Neither macOS path passes through MSI formatting, so brackets are safe
// there. Still accepted here for backward compatibility with older downloads.
var installerTokenBracketRe = regexp.MustCompile(`\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]`)

// parseInstallerFilenameToken extracts the bootstrap token and API host from an
// installer path or basename. It searches anywhere in the string, so a browser
// "(1)" dedup suffix or a full path does not break matching. The paren form is
// tried first (canonical Windows); the bracket form is the legacy/macOS
// fallback. The host charset excludes spaces and the delimiter characters, so a
// trailing " (1)" dedup suffix can never be folded into a match.
func parseInstallerFilenameToken(name string) (token string, host string, err error) {
	for _, re := range []*regexp.Regexp{installerTokenParenRe, installerTokenBracketRe} {
		if m := re.FindStringSubmatch(name); m != nil {
			return m[1], m[2], nil
		}
	}
	return "", "", errNoFilenameToken
}
