package prompthost

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var fixtureDir = filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-host")

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type sentMsg struct {
	Key, Type, Kind string
	Payload         any
}

type fakeDir struct {
	mu        sync.Mutex
	renderers []RendererSession
	sent      []sentMsg
	failSend  map[string]bool
}

func (d *fakeDir) Renderers(o Owner) []RendererSession {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []RendererSession
	for _, r := range d.renderers {
		if r.Owner.Key() == o.Key() {
			out = append(out, r)
		}
	}
	return out
}

func (d *fakeDir) Send(key, msgType, kind string, payload any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.failSend[key] {
		return errRendererGone
	}
	for _, r := range d.renderers {
		if r.Key == key {
			d.sent = append(d.sent, sentMsg{key, msgType, kind, payload})
			return nil
		}
	}
	return errRendererGone
}

func (d *fakeDir) add(r RendererSession) {
	d.mu.Lock()
	d.renderers = append(d.renderers, r)
	d.mu.Unlock()
}

func (d *fakeDir) remove(key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.renderers[:0]
	for _, r := range d.renderers {
		if r.Key != key {
			out = append(out, r)
		}
	}
	d.renderers = out
}

// take returns and clears every message sent so far.
func (d *fakeDir) take() []sentMsg {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := d.sent
	d.sent = nil
	return out
}

type fakeInbox struct {
	mu         sync.Mutex
	entries    map[string]ListEntry
	tombstones map[string]bool
}

func newFakeInbox() *fakeInbox {
	return &fakeInbox{entries: map[string]ListEntry{}, tombstones: map[string]bool{}}
}

func (f *fakeInbox) PutPrompt(e ListEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries[e.ID] = e
	return nil
}

func (f *fakeInbox) RetractPrompt(id string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.entries, id)
}

func (f *fakeInbox) TombstonePrompt(promptID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tombstones[promptID] = true
}

func (f *fakeInbox) PromptTombstoned(promptID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tombstones[promptID]
}

func (f *fakeInbox) PromptEntries(ownerKey string) []ListEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []ListEntry
	for _, e := range f.entries {
		if e.OwnerKey == ownerKey {
			out = append(out, e)
		}
	}
	return out
}

var t0 = time.Date(2026, 10, 26, 12, 0, 0, 0, time.UTC)

var testOwner = Owner{WinSessionID: 1, UserSID: "S-1-5-21-1001"}

func assistRenderer(key string, kinds ...string) RendererSession {
	return RendererSession{Key: key, Role: ipc.HelperRoleAssist, Owner: testOwner, Protocol: 1, KindAds: kinds}
}

func nativeRenderer(key string, kinds ...string) RendererSession {
	return RendererSession{Key: key, Role: ipc.HelperRoleUser, Owner: testOwner, Protocol: 1, KindAds: kinds}
}

type harness struct {
	t     *testing.T
	h     *Host
	dir   *fakeDir
	clock *fakeClock
	inbox *fakeInbox
}

func newHarness(t *testing.T, renderers ...RendererSession) *harness {
	t.Helper()
	dir := &fakeDir{renderers: renderers}
	clock := &fakeClock{t: t0}
	inbox := newFakeInbox()
	h := New(Deps{Broker: dir, Inbox: inbox, Clock: clock})
	h.SetEnabledKinds([]string{"notice.info", "restart.prompt", "remote.consent", "elevation.request"})
	return &harness{t: t, h: h, dir: dir, clock: clock, inbox: inbox}
}

func loadShow(t *testing.T, name string) ipc.PromptShow {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatal(err)
	}
	var show ipc.PromptShow
	if err := json.Unmarshal(raw, &show); err != nil {
		t.Fatal(err)
	}
	return show
}

type promptCalls struct {
	mu      sync.Mutex
	legacy  int
	actions []string
	expired int
	outcome ActionOutcome
	actErr  error
}

func (c *promptCalls) Legacy(Owner) error {
	c.mu.Lock()
	c.legacy++
	c.mu.Unlock()
	return nil
}

func (c *promptCalls) OnAction(actionID string, _ Owner) (ActionOutcome, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.actions = append(c.actions, actionID)
	return c.outcome, c.actErr
}

func (c *promptCalls) OnExpire() {
	c.mu.Lock()
	c.expired++
	c.mu.Unlock()
}

func (c *promptCalls) counts() (legacy, actions, expired int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.legacy, len(c.actions), c.expired
}

// noticePrompt is a notice.info decision (ok = safe).
func noticePrompt(t *testing.T, id string, calls *promptCalls) Prompt {
	show := loadShow(t, "show.notice.json")
	show.PromptID = id
	return Prompt{
		ID: id,
		Kind: KindSpec{Name: "notice.info", Version: 1, Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
			ipc.PromptStatePending: {"ok": ipc.PromptStateApproved},
		}},
		Owners:   []Owner{testOwner},
		Show:     show,
		Legacy:   calls.Legacy,
		OnAction: calls.OnAction,
		OnExpire: calls.OnExpire,
	}
}

// restartPrompt is a restart.prompt decision with an absolute deadline.
func restartPrompt(t *testing.T, id string, deadline time.Time, calls *promptCalls) Prompt {
	show := loadShow(t, "show.restart.json")
	show.PromptID = id
	show.Timing.DeadlineUnixMs = deadline.UnixMilli()
	return Prompt{
		ID: id,
		Kind: KindSpec{Name: "restart.prompt", Version: 1, Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
			ipc.PromptStatePending: {"postpone": ipc.PromptStatePending, "restart_now": ipc.PromptStateApproved},
		}},
		Owners:   []Owner{testOwner},
		Show:     show,
		Legacy:   calls.Legacy,
		OnAction: calls.OnAction,
		OnExpire: calls.OnExpire,
	}
}

func showsTo(msgs []sentMsg, key string) []ipc.PromptShow {
	var out []ipc.PromptShow
	for _, m := range msgs {
		if m.Key == key && m.Type == ipc.TypePromptShow {
			out = append(out, m.Payload.(ipc.PromptShow))
		}
	}
	return out
}

func closesTo(msgs []sentMsg, key string) []ipc.PromptClose {
	var out []ipc.PromptClose
	for _, m := range msgs {
		if m.Key == key && m.Type == ipc.TypePromptClose {
			out = append(out, m.Payload.(ipc.PromptClose))
		}
	}
	return out
}

func updatesTo(msgs []sentMsg, key string) []ipc.PromptUpdate {
	var out []ipc.PromptUpdate
	for _, m := range msgs {
		if m.Key == key && m.Type == ipc.TypePromptUpdate {
			out = append(out, m.Payload.(ipc.PromptUpdate))
		}
	}
	return out
}

func (hh *harness) presented(key string, show ipc.PromptShow) {
	hh.t.Helper()
	raw, _ := json.Marshal(ipc.PromptPresented{PromptID: show.PromptID, Rev: show.Rev, Lease: show.Lease, Visible: true})
	if typ, _ := hh.h.handleRendererMessage(key, ipc.TypePromptPresented, raw); typ != "" {
		hh.t.Fatalf("prompt_presented got a reply %s", typ)
	}
}

func (hh *harness) act(key string, promptID string, rev uint64, lease ipc.PromptLease, actionID string) ipc.PromptActionResult {
	hh.t.Helper()
	raw, _ := json.Marshal(ipc.PromptActionRequest{PromptID: promptID, Rev: rev, Lease: lease, ActionID: actionID, Via: ipc.PromptViaClick})
	typ, reply := hh.h.handleRendererMessage(key, ipc.TypePromptAction, raw)
	if typ != ipc.TypePromptActionResult {
		hh.t.Fatalf("prompt_action reply type = %q", typ)
	}
	return reply.(ipc.PromptActionResult)
}

func (hh *harness) closed(key string, show ipc.PromptShow, reason ipc.PromptClosedReason) {
	hh.t.Helper()
	raw, _ := json.Marshal(ipc.PromptClosed{PromptID: show.PromptID, Rev: show.Rev, Lease: show.Lease, Reason: reason})
	hh.h.handleRendererMessage(key, ipc.TypePromptClosed, raw)
}

func (hh *harness) tick(d time.Duration) {
	hh.clock.Advance(d)
	hh.h.Tick()
}
