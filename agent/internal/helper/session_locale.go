package helper

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// SessionLocaleProbe returns the raw UI language tag of the user signed in to
// the session si, or "" when it is unknown. It must come from a structured
// source for the platform (never from parsing localized prose). The default is
// nil: no locale is written and the Helper keeps its own OS-language fallback.
type SessionLocaleProbe func(si SessionInfo) string

// WithSessionLocale sets the per-session UI locale source (OD1).
func WithSessionLocale(p SessionLocaleProbe) Option {
	return func(m *Manager) { m.sessionLocale = p }
}

// resolveSessionLocale returns the catalog locale for one session, or "" when
// no locale is known. A known but unsupported tag negotiates to English. A
// probe that panics is treated as unknown so it never blocks Helper startup.
func resolveSessionLocale(si SessionInfo, probe SessionLocaleProbe) (locale string) {
	if probe == nil {
		return ""
	}
	defer func() {
		if recover() != nil {
			locale = ""
		}
	}()
	tag := strings.TrimSpace(probe(si))
	if tag == "" {
		return ""
	}
	return string(promptcatalog.Negotiate(tag))
}
