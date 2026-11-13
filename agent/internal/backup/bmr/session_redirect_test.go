package bmr

import (
	"testing"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

// The recovery code and recovery token travel in the bodies of the
// exchange, authenticate, progress and completion calls, all of which use
// newHTTPClient; a 307 or 308 would resend that body to the new location.
func TestRecoveryClientKeepsRedirectsOnServerHost(t *testing.T) {
	httpguardtest.RequireSameHostRedirectsOnly(t, newHTTPClient())
}
