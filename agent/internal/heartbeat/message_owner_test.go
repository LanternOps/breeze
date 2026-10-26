package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #10190 W02 (P5): an endpoint message card belongs to the user it was drawn
// for. A replay never carries it into another user's session; a pre-W02
// (unowned) card binds to the first user it is replayed to.
func TestEndpointMessageNeverReplayedToAnotherUser(t *testing.T) {
	alice := newHelperProbe(t, ipc.HelperRoleAssist, "alice", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	// Fast user switching: bob now owns console session 1 too.
	bob := newHelperProbe(t, ipc.HelperRoleAssist, "bob", "1", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	alice.session.UID, bob.session.UID = 1001, 1002
	h, _ := newMessagingHeartbeat(t, alice.session, bob.session)
	now := time.Now()

	if err := h.endpointMessages.PutFor(testShow("for-alice", now.Add(time.Hour)), messageOwnerKey(alice.session), now); err != nil {
		t.Fatal(err)
	}
	if err := h.endpointMessages.Put(testShow("pre-w02", now.Add(time.Hour)), now); err != nil {
		t.Fatal(err)
	}
	if messageOwnerKey(alice.session) == messageOwnerKey(bob.session) {
		t.Fatal("test setup: alice and bob must be different principals")
	}

	h.replayEndpointMessages(bob.session) // bob connects first: the unowned card binds to him
	h.replayEndpointMessages(alice.session)
	time.Sleep(150 * time.Millisecond)

	ids := func(p *helperProbe) []string {
		var out []string
		for _, env := range p.envelopes() {
			if env.Type == ipc.TypeMessageShow {
				var show ipc.MessageShow
				_ = json.Unmarshal(env.Payload, &show)
				out = append(out, show.MessageID)
			}
		}
		return out
	}
	if got := ids(bob); len(got) != 1 || got[0] != "pre-w02" {
		t.Fatalf("bob got %v, want only the unowned pre-W02 card", got)
	}
	if got := ids(alice); len(got) != 1 || got[0] != "for-alice" {
		t.Fatalf("alice got %v, want only her own card", got)
	}
}
