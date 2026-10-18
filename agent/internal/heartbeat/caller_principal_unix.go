//go:build !windows

package heartbeat

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// principalForCaller reports the helper's kernel-verified peer UID. No
// supported Unix detector exposes a verified directory UPN, so UPN stays
// empty (an unbound, tier-1 answer) rather than being guessed.
func principalForCaller(s *sessionbroker.Session, loginUsername string) *callerPrincipal {
	if s == nil || strings.TrimSpace(loginUsername) == "" {
		return nil
	}
	uid := s.UID
	return &callerPrincipal{UID: &uid, Username: loginUsername}
}
