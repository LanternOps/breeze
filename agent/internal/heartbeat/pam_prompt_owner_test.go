package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// The elevation prompt's owner is the requester's session and the user
// principal of a non-SYSTEM helper there, never a helper in another session
// and never the SYSTEM helper's own identity.
func TestElevationOwnerIsTheRequestersSessionUser(t *testing.T) {
	prev := messageOwnerGOOS
	messageOwnerGOOS = "windows" // elevation prompts exist only there
	t.Cleanup(func() { messageOwnerGOOS = prev })
	b := sessionbroker.New("elevation-owner", nil)
	h := &Heartbeat{sessionBroker: b}

	sys := registerConsentTestSession(t, b, "3", ipc.HelperRoleSystem, []string{ipc.ScopePam, ipc.ScopePrompt})
	sys.IdentityKey = "S-1-5-18"
	other := registerConsentTestSession(t, b, "5", ipc.HelperRoleUser, []string{"notify"})
	other.IdentityKey = "S-1-5-21-5005"

	// Only the SYSTEM helper in session 3: the session alone (Assist can
	// never match it, only the SYSTEM helper serves it).
	o, ok := h.elevationOwner("3")
	if !ok || o.WinSessionID != 3 || o.UserSID != "" {
		t.Fatalf("owner with only a SYSTEM helper = %+v %v", o, ok)
	}

	user := registerConsentTestSession(t, b, "3", ipc.HelperRoleUser, []string{"notify"})
	user.IdentityKey = "S-1-5-21-3003"
	o, ok = h.elevationOwner("3")
	if !ok || o.WinSessionID != 3 || o.UserSID != "S-1-5-21-3003" {
		t.Fatalf("owner = %+v %v, want session 3's user", o, ok)
	}
	if _, ok := h.elevationOwner(""); ok {
		t.Fatal("no requester session: no owner")
	}
	if _, ok := (&Heartbeat{}).elevationOwner("3"); ok {
		t.Fatal("no broker: no owner")
	}
}
