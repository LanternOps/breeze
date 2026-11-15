package workspaceindex

import (
	"testing"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

func TestClientKeepsRedirectsOnServerHost(t *testing.T) {
	c := NewClient(ClientConfig{ServerURL: func() string { return httpguardtest.Origin }})
	httpguardtest.RequireSameHostRedirectsOnly(t, c.httpClient)
}
