package agentapp

import (
	"errors"
	"regexp"
)

// errNoFilenameToken is returned when a filename carries no [TOKEN@HOST] group.
var errNoFilenameToken = errors.New("no bootstrap token in installer filename")

// installerTokenRe mirrors FilenameTokenParser.swift: a 10-char base36 token
// and a host, wrapped in square brackets. The token charset is uppercase to
// avoid ambiguity; the host allows letters, digits, dots, and hyphens.
var installerTokenRe = regexp.MustCompile(`\[([A-Z0-9]{10})@([a-zA-Z0-9.\-]+)\]`)

// parseInstallerFilenameToken extracts the bootstrap token and API host from an
// installer path or basename. It searches anywhere in the string, so a browser
// "(1)" dedup suffix or a full path does not break matching.
func parseInstallerFilenameToken(name string) (token string, host string, err error) {
	m := installerTokenRe.FindStringSubmatch(name)
	if m == nil {
		return "", "", errNoFilenameToken
	}
	return m[1], m[2], nil
}
