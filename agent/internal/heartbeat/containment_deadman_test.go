package heartbeat

import (
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation"
)

// contactFake counts the contacts the heartbeat path reports (#10103).
type contactFake struct {
	containmentFake
	contacts atomic.Int32
}

func (f *contactFake) NoteControlPlaneContact() { f.contacts.Add(1) }

// Every validated heartbeat response is authenticated control-plane contact,
// whether or not it carries a containment block: the dead-man measures the
// channel, not the assertion.
func TestContainmentHeartbeatResponseIsContact(t *testing.T) {
	f := &contactFake{}
	h := &Heartbeat{containment: newContainmentRuntime(f)}
	h.reconcileContainment(nil)
	h.reconcileContainment(&isolation.DesiredBlock{})
	if got := f.contacts.Load(); got != 2 {
		t.Fatalf("contacts %d, want 2", got)
	}
	// No runtime (containment never initialised): nothing to note, no panic.
	(&Heartbeat{}).reconcileContainment(nil)
}

// securityCapabilities.networkIsolationDeadMan is its own flag (decision 28),
// advertised only by a build that can isolate, and omitted otherwise.
func TestContainmentAdvertisesDeadManFlag(t *testing.T) {
	previous := currentContainmentPlatform.Load()
	t.Cleanup(func() { currentContainmentPlatform.Store(previous) })
	for _, tc := range []struct {
		name string
		cap  isolation.Capability
		want bool
	}{
		{"cannot isolate", isolation.Capability{Mechanism: "wfp", UnsupportedReason: "not_activated"}, false},
		{"capable, not ready", isolation.Capability{Version: 1, Mechanism: "pf"}, true},
		{"capable, ready", isolation.Capability{Version: 1, Mechanism: "nft", Ready: true}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			currentContainmentPlatform.Store(&containmentPlatform{isolator: staticCapabilityIsolator{cap: tc.cap}})
			var got SecurityCapabilities
			containmentCapabilities(&got)
			if got.NetworkIsolationDeadMan != tc.want {
				t.Fatalf("networkIsolationDeadMan %v, want %v", got.NetworkIsolationDeadMan, tc.want)
			}
			wire, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			if has := strings.Contains(string(wire), `"networkIsolationDeadMan":true`); has != tc.want {
				t.Fatalf("wire %s", wire)
			}
			if !tc.want && strings.Contains(string(wire), "networkIsolationDeadMan") {
				t.Fatalf("an incapable build sent the flag: %s", wire)
			}
		})
	}
}
