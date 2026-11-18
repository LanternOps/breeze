package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

func TestShipperClientKeepsRedirectsOnServerHost(t *testing.T) {
	httpguardtest.RequireSameHostRedirectsOnly(t, newShipperHTTPClient())
}
