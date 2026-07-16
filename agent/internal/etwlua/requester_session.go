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
	trustedImagePath = normalizeWindowsPath(trustedImagePath)
	if trustedImagePath == "" {
		return consentProcessCandidate{}, false
	}

	var selected consentProcessCandidate
	found := false
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
		if !found || candidate.StartedAt.After(selected.StartedAt) ||
			(candidate.StartedAt.Equal(selected.StartedAt) && candidate.PID > selected.PID) {
			selected = candidate
			found = true
		}
	}
	return selected, found
}

func resolveRequesterSessionWith(
	candidates []consentProcessCandidate,
	trustedImagePath string,
	now time.Time,
	consoleSessionID uint32,
	lookupSessionUser func(sessionID uint32) string,
) (username string, sessionID uint32, source string) {
	if lookupSessionUser == nil {
		return "", 0, requesterSourceUnresolved
	}

	if candidate, ok := selectNewestConsentProcess(candidates, trustedImagePath, now); ok {
		if user := lookupSessionUser(candidate.SessionID); user != "" {
			return user, candidate.SessionID, requesterSourceConsentProcess
		}
	}

	if validInteractiveSessionID(consoleSessionID) {
		if user := lookupSessionUser(consoleSessionID); user != "" {
			return user, consoleSessionID, requesterSourceConsoleFallback
		}
	}
	return "", 0, requesterSourceUnresolved
}

func resolveRequesterSessionAfterEnumeration(
	candidates []consentProcessCandidate,
	enumerationErr error,
	trustedImagePath string,
	now time.Time,
	consoleSessionID uint32,
	lookupSessionUser func(sessionID uint32) string,
) (username string, sessionID uint32, source string) {
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
