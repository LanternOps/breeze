package etwlua

import (
	"strings"
	"time"
)

const (
	requesterSourceConsentProcess  = "consent_process"
	requesterSourceConsoleFallback = "console_fallback"
	requesterSourceUnresolved      = "unresolved"
)

// consentProcessCandidate is the trusted process metadata needed to attribute
// a UAC request to the interactive session that owns the live consent UI.
type consentProcessCandidate struct {
	PID       uint32
	SessionID uint32
	ImagePath string
	StartedAt time.Time
}

func selectNewestConsentProcess(
	candidates []consentProcessCandidate,
	trustedImagePath string,
	now time.Time,
) (consentProcessCandidate, bool) {
	selected, _, found := selectNewestConsentProcessCounted(candidates, trustedImagePath, now)
	return selected, found
}

// selectNewestConsentProcessCounted also reports how many candidates were
// eligible, so callers can tell an unambiguous attribution from a guess.
func selectNewestConsentProcessCounted(
	candidates []consentProcessCandidate,
	trustedImagePath string,
	now time.Time,
) (selected consentProcessCandidate, eligible int, found bool) {
	trustedImagePath = normalizeWindowsPath(trustedImagePath)
	if trustedImagePath == "" {
		return consentProcessCandidate{}, 0, false
	}

	for _, candidate := range candidates {
		if !strings.EqualFold(normalizeWindowsPath(candidate.ImagePath), trustedImagePath) ||
			!validInteractiveSessionID(candidate.SessionID) ||
			candidate.StartedAt.IsZero() {
			continue
		}

		age := now.Sub(candidate.StartedAt)
		if age < 0 || age > dedupeWindow {
			continue
		}
		eligible++
		if !found || candidate.StartedAt.After(selected.StartedAt) ||
			(candidate.StartedAt.Equal(selected.StartedAt) && candidate.PID > selected.PID) {
			selected = candidate
			found = true
		}
	}
	return selected, eligible, found
}

// requesterResolution is who raised a UAC prompt and, when it could be pinned
// down, which consent.exe process is showing it.
type requesterResolution struct {
	Username  string
	SessionID uint32
	Source    string
	// Consent identifies the consent.exe the request was attributed to. Set
	// only for requesterSourceConsentProcess AND only when exactly one recent
	// consent.exe was eligible: a console-fallback attribution names a
	// session, not a prompt, and "newest of several" is a guess that could
	// name another request's prompt. Either way it must never be used to
	// target one (#8995).
	Consent ConsentInstance
}

func resolveRequesterSessionWith(
	candidates []consentProcessCandidate,
	trustedImagePath string,
	now time.Time,
	consoleSessionID uint32,
	lookupSessionUser func(sessionID uint32) string,
) requesterResolution {
	if lookupSessionUser == nil {
		return requesterResolution{Source: requesterSourceUnresolved}
	}

	if candidate, eligible, ok := selectNewestConsentProcessCounted(candidates, trustedImagePath, now); ok {
		if user := lookupSessionUser(candidate.SessionID); user != "" {
			resolution := requesterResolution{
				Username:  user,
				SessionID: candidate.SessionID,
				Source:    requesterSourceConsentProcess,
			}
			if eligible == 1 {
				resolution.Consent = ConsentInstance{PID: candidate.PID, CreatedAt: candidate.StartedAt}
			}
			return resolution
		}
	}

	if validInteractiveSessionID(consoleSessionID) {
		if user := lookupSessionUser(consoleSessionID); user != "" {
			return requesterResolution{Username: user, SessionID: consoleSessionID, Source: requesterSourceConsoleFallback}
		}
	}
	return requesterResolution{Source: requesterSourceUnresolved}
}

func resolveRequesterSessionAfterEnumeration(
	candidates []consentProcessCandidate,
	enumerationErr error,
	trustedImagePath string,
	now time.Time,
	consoleSessionID uint32,
	lookupSessionUser func(sessionID uint32) string,
) requesterResolution {
	if enumerationErr != nil {
		candidates = nil
	}
	return resolveRequesterSessionWith(
		candidates,
		trustedImagePath,
		now,
		consoleSessionID,
		lookupSessionUser,
	)
}

func normalizeWindowsPath(path string) string {
	path = strings.TrimSpace(path)
	if len(path) >= 4 && strings.EqualFold(path[:4], `\\?\`) {
		path = path[4:]
	}
	path = strings.ReplaceAll(path, "/", `\`)
	return strings.TrimRight(path, `\`)
}

func validInteractiveSessionID(sessionID uint32) bool {
	return sessionID != 0 && sessionID != 0xFFFFFFFF
}
