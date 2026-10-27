package heartbeat

import (
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// brandingDir is a prompt-host directory whose branding sync to one renderer
// can be held mid-flush (the host holds its flush lock while it builds and
// sends each sync, reading the identity cache).
type brandingDir struct {
	mu        sync.Mutex
	renderers []prompthost.RendererSession
	holdKey   string
	held      chan struct{} // closed when the held send starts
	release   chan struct{}
}

func (d *brandingDir) Renderers(prompthost.Owner) []prompthost.RendererSession { return nil }

func (d *brandingDir) PromptRenderers() []prompthost.RendererSession {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]prompthost.RendererSession(nil), d.renderers...)
}

func (d *brandingDir) Send(key, msgType, _ string, _ any) error {
	d.mu.Lock()
	hold := d.holdKey == key && msgType == ipc.TypePromptBrandingSync
	held, release := d.held, d.release
	if hold {
		d.holdKey = ""
	}
	d.mu.Unlock()
	if hold {
		close(held)
		<-release
	}
	return nil
}

// #10190 W04 review: a scope change used to take down the old scope's
// prompts from inside the identity store's lock (OnScopeChange ->
// purgePromptScope -> Host.CloseScope -> the host's flush lock), while a
// branding flush holds the host's flush lock and reads the identity store.
// The two orders deadlocked the heartbeat.
func TestScopeChangeDuringABrandingFlushDoesNotDeadlock(t *testing.T) {
	h, _, _ := identityHeartbeat(t, fixtureLogoHandler(t))
	dir := &brandingDir{renderers: []prompthost.RendererSession{
		{Key: "r1", Role: ipc.HelperRoleUser, Protocol: 1, KindAds: []string{"notice.info@1"}},
		{Key: "r2", Role: ipc.HelperRoleUser, Protocol: 1, KindAds: []string{"notice.info@1"}},
	}}
	h.promptHost = prompthost.New(prompthost.Deps{Broker: dir, Identity: h.promptIdentity})
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA)})

	// A branding flush is under way and paused on its first renderer.
	dir.mu.Lock()
	dir.holdKey, dir.held, dir.release = "r1", make(chan struct{}), make(chan struct{})
	held, release := dir.held, dir.release
	dir.mu.Unlock()
	flushDone := make(chan struct{})
	go func() { h.promptHost.IdentityChanged(); close(flushDone) }()
	select {
	case <-held:
	case <-time.After(5 * time.Second):
		t.Fatal("the branding flush never started")
	}

	// The scope changes meanwhile; then the flush resumes and reads the
	// identity for its second renderer.
	applyDone := make(chan struct{})
	go func() {
		h.applyPromptIdentity(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeB)})
		close(applyDone)
	}()
	time.Sleep(300 * time.Millisecond)
	close(release)

	deadline := time.After(10 * time.Second)
	for _, ch := range []chan struct{}{flushDone, applyDone} {
		select {
		case <-ch:
		case <-deadline:
			t.Fatal("deadlock: a scope change and a branding flush wait on each other (identity lock vs prompt host flush lock)")
		}
	}
	if cur, ok := h.promptIdentity.Current(); !ok || cur.ScopeID != hbScopeB {
		t.Fatalf("identity after the change = %+v", cur)
	}
}
