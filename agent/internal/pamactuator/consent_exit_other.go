//go:build !windows

package pamactuator

import "errors"

// errConsentExitUnsupported: the platform cannot read process facts.
var errConsentExitUnsupported = errors.New("consent.exe liveness is only readable on Windows")

func readConsentProcessFacts(uint32) (consentProcessFacts, error) {
	return consentProcessFacts{}, errConsentExitUnsupported
}
