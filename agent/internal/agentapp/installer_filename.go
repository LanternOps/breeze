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
//
// A nonstandard server port is carried as an optional `_PORT` suffix
// (HOST_8443), because `:` is illegal in Windows filenames — Chromium-based
// browsers rewrite it to `_` at save time, which used to make the whole match
// fail and the install silently skip enrollment (#2341). Underscore never
// appears in a hostname, so the suffix is unambiguous, and since it equals
// the Chromium sanitization of the old `host:port` form, files downloaded
// from older servers parse the same way.
var installerTokenParenRe = regexp.MustCompile(`\(([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)(?:_([0-9]{1,5}))?\)`)

// installerTokenBracketRe is the legacy form: [TOKEN@HOST] in square brackets
// (mirrors FilenameTokenParser.swift). The current macOS path carries the token
// in an embedded bootstrap.json (no filename delimiter); the bracketed .app
// bundle name only appears under the opt-in MACOS_INSTALLER_FILENAME_TOKEN_COMPAT
// mode. Neither macOS path passes through MSI formatting, so brackets are safe
// there. Still accepted here for backward compatibility with older downloads.
var installerTokenBracketRe = regexp.MustCompile(`\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)(?:_([0-9]{1,5}))?\]`)

// parseInstallerFilenameToken extracts the bootstrap token and API host from an
// installer path or basename. It searches anywhere in the string, so a browser
// "(1)" dedup suffix or a full path does not break matching. The paren form is
// tried first (canonical Windows); the bracket form is the legacy/macOS
// fallback. The host charset excludes spaces and the delimiter characters, so a
// trailing " (1)" dedup suffix can never be folded into a match. An optional
// `_PORT` suffix is decoded back to `host:port` (see installerTokenParenRe).
func parseInstallerFilenameToken(name string) (token string, host string, err error) {
	for _, re := range []*regexp.Regexp{installerTokenParenRe, installerTokenBracketRe} {
		if m := re.FindStringSubmatch(name); m != nil {
			host = m[2]
			if m[3] != "" {
				host += ":" + m[3]
			}
			return m[1], host, nil
		}
	}
	return "", "", errNoFilenameToken
}
