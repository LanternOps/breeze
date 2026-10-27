package prompthost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

var (
	// ErrTombstoned: the prompt was decided or closed in the last 24 h (or
	// is in its terminal linger); it is never drawn again.
	ErrTombstoned = errors.New("prompthost: prompt already decided")
	// ErrUnknownPrompt: no open prompt has that id.
	ErrUnknownPrompt = errors.New("prompthost: unknown prompt")

	errRendererGone = errors.New("prompthost: renderer gone")
)

// Deps are the host's collaborators.
type Deps struct {
	Broker RendererDirectory
	Inbox  PromptInbox // optional
	Clock  Clock       // optional; the system clock by default
	Log    *slog.Logger
	// Identity is the cached MSP identity sent in prompt_branding_sync
	// (optional; nil = always {cleared:true}).
	Identity IdentitySource
	// OSLocale is the machine's UI language, the fallback for a renderer
	// that reported none (optional; nil = en).
	OSLocale func() string
}

// Host is the agent's prompt host. All methods are safe for concurrent use.
//
// Locking, in acquisition order:
//   - actionMu serializes decisions (actions and expiry), so a domain
//     callback runs outside mu yet two answers — or an answer and the
//     deadline — apply exactly one decision.
//   - mu guards all state. It is never held across a send, an inbox write
//     or a domain callback: those are queued on an outbox.
//   - flushMu is taken before mu is released and held while the outbox's
//     sends and inbox writes run, so they leave in the order the state
//     changed (a prompt_close never overtakes its prompt_show). Nothing
//     holding flushMu ever waits for mu. Domain callbacks run after it.
type Host struct {
	dir   RendererDirectory
	inbox PromptInbox
	clock Clock
	log   *slog.Logger

	identity IdentitySource
	osLocale func() string

	actionMu sync.Mutex
	flushMu  sync.Mutex

	mu        sync.Mutex
	enabled   EnabledKinds
	prompts   map[string]*record
	tombs     *tombstones
	limiter   *cardLimiter
	locked    map[uint32]bool
	connected map[string]RendererSession // renderers awaiting replay at the next tick
}

type deferReason int

const (
	deferNone deferReason = iota
	deferLocked
	deferModal
)

type record struct {
	p                Prompt
	show             ipc.PromptShow // current content; Rev is the current rev
	createdAt        time.Time
	firstPresentedAt time.Time
	lingerUntil      time.Time
	expiryFired      bool
	everPrompt       bool // some owner was ever placed on the prompt path
	headlessDone     bool
	placements       []*placement
	results          map[actionKey]ipc.PromptActionResult
}

type actionKey struct {
	actionID string
	rev      uint64
}

// placement is one prompt as delivered to one owner's session.
type placement struct {
	owner       Owner
	path        Path
	renderer    string // broker session id while on the prompt path
	version     int
	epoch       uint32
	presented   bool
	presentBy   time.Time
	graceUntil  time.Time
	deferred    deferReason
	listOnly    bool // rate-limited or collapsed on replay: no window, no present budget
	rateChecked bool
	hidden      bool
	sendFailed  bool // the last prompt_show never left; fall back at the next tick
	legacyDone  bool
	tried       map[string]bool
}

func (pl *placement) lease() ipc.PromptLease {
	return ipc.PromptLease{RendererSession: pl.renderer, Epoch: pl.epoch}
}

// New builds a host with an empty kind registry and nothing enabled.
func New(deps Deps) *Host {
	h := &Host{
		dir:       deps.Broker,
		inbox:     deps.Inbox,
		clock:     deps.Clock,
		log:       deps.Log,
		identity:  deps.Identity,
		osLocale:  deps.OSLocale,
		prompts:   map[string]*record{},
		tombs:     newTombstones(deps.Inbox),
		limiter:   newCardLimiter(),
		locked:    map[uint32]bool{},
		connected: map[string]RendererSession{},
	}
	if h.clock == nil {
		h.clock = systemClock{}
	}
	if h.log == nil {
		h.log = logging.L("prompthost")
	}
	h.enabled = parseEnabledKinds(nil)
	return h
}

// Run ticks the host once a second until ctx ends.
func (h *Host) Run(ctx context.Context) {
	t := time.NewTicker(tickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			h.Tick()
		}
	}
}

// SetEnabledKinds applies the server kill switch (heartbeat
// promptHost.enabledKinds). It affects new placements only: a prompt already
// presented finishes on its renderer (P15).
func (h *Host) SetEnabledKinds(entries []string) {
	e := parseEnabledKinds(entries)
	h.mu.Lock()
	h.enabled = e
	h.mu.Unlock()
}

// SessionStateChanged records a Windows session lock / unlock. Prompts for a
// locked session are held (list entry only) and drawn at unlock.
func (h *Host) SessionStateChanged(winSession uint32, ev SessionEvent) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch ev {
	case SessionLocked:
		h.locked[winSession] = true
	case SessionUnlocked:
		delete(h.locked, winSession)
	}
}

// Show creates a prompt, or replaces the content of the open prompt with
// the same id (it never draws a second window, and a replacement never
// takes focus).
func (h *Host) Show(p Prompt) error {
	if p.ID == "" {
		p.ID = p.Show.PromptID
	}
	if p.Show.PromptID != "" && p.Show.PromptID != p.ID {
		return fmt.Errorf("prompthost: prompt id %q != show.promptId %q", p.ID, p.Show.PromptID)
	}
	if len(p.Owners) == 0 {
		return errors.New("prompthost: prompt has no owner")
	}
	p.Show.PromptID = p.ID
	p.Show.Kind = p.Kind.Name
	p.Show.KindVersion = p.Kind.Version
	p.Show.Lease = ipc.PromptLease{RendererSession: "host", Epoch: 1}
	if p.Show.Actions == nil {
		p.Show.Actions = []ipc.PromptAction{}
	}
	probe := p.Show
	probe.Rev = 1
	if err := ipc.ValidatePromptShow(probe); err != nil {
		return fmt.Errorf("prompthost: %w", err)
	}

	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	if h.tombs.has(p.ID, now) {
		h.mu.Unlock()
		return ErrTombstoned
	}
	if rec := h.prompts[p.ID]; rec != nil {
		if !rec.lingerUntil.IsZero() {
			// Decided: in its terminal linger. A re-asserted show must not
			// redraw it as pending.
			h.mu.Unlock()
			return ErrTombstoned
		}
		rev := rec.show.Rev + 1
		rec.p = p
		rec.show = p.Show
		rec.show.Rev = rev
		for _, pl := range rec.placements {
			if pl.path == PathPrompt && pl.renderer != "" {
				s := h.wireShow(rec, pl)
				s.Focus = ipc.PromptFocusNoActivate
				ob.send(pl.renderer, ipc.TypePromptShow, rec.show.Kind, rec.show.PromptID, pl, s)
			}
		}
		h.addMissingOwners(rec, now, ob)
		h.persist(rec, now, ob)
		h.unlockAndFlush(ob)
		return nil
	}
	rec := &record{p: p, show: p.Show, createdAt: now, results: map[actionKey]ipc.PromptActionResult{}}
	rec.show.Rev = 1
	h.prompts[p.ID] = rec
	h.addMissingOwners(rec, now, ob)
	h.persist(rec, now, ob)
	h.unlockAndFlush(ob)
	return nil
}

func (h *Host) addMissingOwners(rec *record, now time.Time, ob *outbox) {
	for _, o := range rec.p.Owners {
		known := false
		for _, pl := range rec.placements {
			if pl.owner.Key() == o.Key() {
				known = true
				break
			}
		}
		if known {
			continue
		}
		pl := &placement{owner: o, tried: map[string]bool{}}
		rec.placements = append(rec.placements, pl)
		h.place(rec, pl, now, ob, false)
	}
}

// Update applies a patch to an open prompt and updates every renderer.
func (h *Host) Update(id string, patch Patch) error {
	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	rec := h.prompts[id]
	if rec == nil {
		tomb := h.tombs.has(id, now)
		h.mu.Unlock()
		if tomb {
			return ErrTombstoned
		}
		return ErrUnknownPrompt
	}
	if !rec.lingerUntil.IsZero() {
		h.mu.Unlock()
		return fmt.Errorf("prompthost: %s is already in a terminal state", id)
	}
	err := h.applyPatch(rec, patch, now, ob)
	h.unlockAndFlush(ob)
	return err
}

// Close takes a prompt down on every renderer and tombstones it.
func (h *Host) Close(id string, reason ipc.PromptCloseReason) error {
	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	rec := h.prompts[id]
	if rec == nil {
		tomb := h.tombs.has(id, now)
		h.mu.Unlock()
		if tomb {
			return nil
		}
		return ErrUnknownPrompt
	}
	h.closeLocked(rec, reason, now, ob)
	h.unlockAndFlush(ob)
	return nil
}

// RendererConnected queues a replay into a renderer that just authenticated.
// The replay runs at the next tick (within a second) so the broker's
// connection goroutine never waits on the host.
func (h *Host) RendererConnected(r RendererSession) {
	h.mu.Lock()
	h.connected[r.Key] = r
	h.mu.Unlock()
}

// RendererDisconnected starts the grace period for open decisions on that
// renderer; non-decision prompts wait for a replay.
func (h *Host) RendererDisconnected(sessionKey string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.clock.Now()
	delete(h.connected, sessionKey)
	for _, rec := range h.prompts {
		for _, pl := range rec.placements {
			if pl.path != PathPrompt || pl.renderer != sessionKey {
				continue
			}
			if ipc.IsPromptDecision(rec.show.State, rec.show.Presentation) && !pl.listOnly {
				pl.graceUntil = now.Add(assistDisconnectGrace)
				continue
			}
			// Nothing to re-ask: the entry comes back with the next replay.
			pl.renderer = ""
			pl.epoch++
			pl.presented = false
		}
	}
}

// openCount is the number of open prompts (tests).
func (h *Host) openCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.prompts)
}

// place selects a path for one owner and delivers the prompt there.
func (h *Host) place(rec *record, pl *placement, now time.Time, ob *outbox, fromFallback bool) {
	ws := pl.owner.WinSessionID
	switch {
	case ws != 0 && h.locked[ws] && !rec.p.Kind.ShowWhileLocked:
		pl.deferred = deferLocked
		return
	case rec.show.Presentation == ipc.PromptPresentationModal && h.modalBusy(rec, pl.owner):
		pl.deferred = deferModal
		return
	}
	pl.deferred = deferNone
	h.assign(rec, pl, h.choose(rec, pl), now, ob, fromFallback)
}

func (h *Host) choose(rec *record, pl *placement) Choice {
	return selectRenderer(rec.p.Kind.Name, []int{rec.p.Kind.Version}, h.dir.Renderers(pl.owner), h.enabled, pl.tried, rec.p.Legacy != nil, rec.p.Headless != nil)
}

func (h *Host) modalBusy(rec *record, o Owner) bool {
	for _, other := range h.prompts {
		if other == rec || other.show.Presentation != ipc.PromptPresentationModal || !other.lingerUntil.IsZero() {
			continue
		}
		for _, pl := range other.placements {
			if pl.owner.Key() == o.Key() && pl.deferred == deferNone && pl.path == PathPrompt {
				return true
			}
		}
	}
	return false
}

// assign moves a placement onto the chosen path.
func (h *Host) assign(rec *record, pl *placement, c Choice, now time.Time, ob *outbox, fromFallback bool) {
	pl.path = c.Path
	pl.sendFailed = false
	switch c.Path {
	case PathPrompt:
		pl.epoch++ // a new lease for every assignment; older leases are stale
		pl.renderer = c.Renderer.Key
		pl.version = c.Version
		pl.presented = false
		pl.hidden = false
		pl.graceUntil = time.Time{}
		pl.presentBy = now.Add(presentWithin(rec))
		rec.everPrompt = true
		if !pl.rateChecked {
			pl.rateChecked = true
			if rec.show.Presentation == ipc.PromptPresentationCard && !h.limiter.allow(pl.owner.Key(), now) {
				pl.listOnly = true
			}
		}
		ob.send(pl.renderer, ipc.TypePromptShow, rec.show.Kind, rec.show.PromptID, pl, h.wireShow(rec, pl))
	case PathLegacy:
		pl.renderer = ""
		if !pl.legacyDone {
			pl.legacyDone = true
			legacy, o, id := rec.p.Legacy, pl.owner, rec.show.PromptID
			ob.call(func() {
				if err := legacy(o); err != nil {
					h.log.Warn("legacy prompt delivery failed", "promptId", id, "owner", o.Key(), "error", err.Error())
				}
			})
		}
	case PathHeadless:
		pl.renderer = ""
		if !rec.headlessDone {
			rec.headlessDone = true
			headless, id := rec.p.Headless, rec.show.PromptID
			ob.call(func() {
				if err := headless(); err != nil {
					h.log.Warn("headless prompt delivery failed", "promptId", id, "error", err.Error())
				}
			})
		}
	default:
		pl.renderer = ""
		args := []any{"promptId", rec.show.PromptID, "kind", rec.show.Kind, "owner", pl.owner.Key()}
		if fromFallback || ipc.IsPromptDecision(rec.show.State, rec.show.Presentation) {
			// A decision nobody can draw only expires: say so loudly.
			h.log.Warn("prompt has no renderer", args...)
		} else {
			h.log.Info("prompt has no renderer", args...)
		}
	}
}

func presentWithin(rec *record) time.Duration {
	if ms := rec.show.Timing.PresentWithinMs; ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return defaultPresentWithin
}

// wireShow is the prompt_show one placement's renderer receives. A
// list-only placement keeps an indicator an indicator (a pill is not a
// card and is never a decision).
func (h *Host) wireShow(rec *record, pl *placement) ipc.PromptShow {
	s := rec.show
	s.Facts = append([]ipc.PromptFact(nil), rec.show.Facts...)
	s.Actions = append([]ipc.PromptAction{}, rec.show.Actions...)
	s.Lease = pl.lease()
	s.KindVersion = pl.version
	s.Timing = rec.wireTiming()
	if pl.listOnly && s.Presentation != ipc.PromptPresentationIndicator {
		s.Presentation = ipc.PromptPresentationListOnly
		s.Focus = ipc.PromptFocusNoActivate
	}
	return s
}

// wireTiming never restarts a budget: once a response window has started
// (first presentation), every later renderer gets the absolute deadline.
func (r *record) wireTiming() ipc.PromptTiming {
	t := r.show.Timing
	if t.ResponseMs > 0 && !r.firstPresentedAt.IsZero() {
		t.DeadlineUnixMs = r.firstPresentedAt.UnixMilli() + t.ResponseMs
		t.ResponseMs = 0
	}
	return t
}

// deadline is the moment the response budget runs out (zero = none yet).
func (r *record) deadline() time.Time {
	t := r.show.Timing
	switch {
	case t.DeadlineUnixMs > 0:
		return time.UnixMilli(t.DeadlineUnixMs)
	case t.ResponseMs > 0 && !r.firstPresentedAt.IsZero():
		return r.firstPresentedAt.Add(time.Duration(t.ResponseMs) * time.Millisecond)
	}
	return time.Time{}
}

// fence takes a placement off its renderer: the renderer's lease is dead
// from here on, and a reachable renderer is told to take its window down.
func (h *Host) fence(rec *record, pl *placement, ob *outbox) {
	if pl.path != PathPrompt || pl.renderer == "" {
		return
	}
	ob.send(pl.renderer, ipc.TypePromptClose, rec.show.Kind, rec.show.PromptID, nil,
		ipc.PromptClose{PromptID: rec.show.PromptID, Rev: rec.show.Rev, Lease: pl.lease(), Reason: ipc.PromptCloseFenced})
	pl.epoch++
	pl.renderer = ""
}

// fallback moves a placement off a renderer that failed it (render_failed,
// a missed present budget, a failed send, or a renderer gone past its grace).
func (h *Host) fallback(rec *record, pl *placement, now time.Time, ob *outbox, why string) {
	if pl.renderer != "" {
		pl.tried[pl.renderer] = true
	}
	h.log.Info("prompt falling back", "promptId", rec.show.PromptID, "owner", pl.owner.Key(), "from", pl.renderer, "reason", why)
	h.fence(rec, pl, ob)
	pl.graceUntil = time.Time{}
	h.assign(rec, pl, h.choose(rec, pl), now, ob, true)
}

func (h *Host) applyPatch(rec *record, patch Patch, now time.Time, ob *outbox) error {
	u := ipc.PromptUpdate{
		PromptID:        rec.show.PromptID,
		Rev:             rec.show.Rev + 1,
		Lease:           rec.show.Lease,
		State:           patch.State,
		Copy:            patch.Copy,
		Facts:           patch.Facts,
		Actions:         patch.Actions,
		DefaultActionID: patch.DefaultActionID,
		Timing:          patch.Timing,
	}
	merged, err := ipc.ApplyPromptUpdate(rec.show, u)
	if err != nil {
		return fmt.Errorf("prompthost: %w", err)
	}
	merged.Lease = rec.show.Lease
	rec.show = merged
	for _, pl := range rec.placements {
		if pl.path != PathPrompt || pl.renderer == "" {
			continue
		}
		wu := u
		wu.Lease = pl.lease()
		if wu.Timing != nil {
			t := rec.wireTiming()
			wu.Timing = &t
		}
		ob.send(pl.renderer, ipc.TypePromptUpdate, rec.show.Kind, rec.show.PromptID, nil, wu)
	}
	if merged.State.Terminal() {
		linger := rec.p.Kind.Linger
		if linger <= 0 {
			linger = defaultLinger
		}
		rec.lingerUntil = now.Add(linger)
	}
	h.persist(rec, now, ob)
	return nil
}

func (h *Host) closeLocked(rec *record, reason ipc.PromptCloseReason, now time.Time, ob *outbox) {
	for _, pl := range rec.placements {
		if pl.path == PathPrompt && pl.renderer != "" {
			ob.send(pl.renderer, ipc.TypePromptClose, rec.show.Kind, rec.show.PromptID, nil,
				ipc.PromptClose{PromptID: rec.show.PromptID, Rev: rec.show.Rev, Lease: pl.lease(), Reason: reason})
		}
	}
	delete(h.prompts, rec.show.PromptID)
	h.tombs.add(rec.show.PromptID, now, ob, h)
	if h.inbox == nil || !rec.show.ListEntry.Persistent {
		return
	}
	// What stays in the list must be an outcome, never a decision whose
	// actions no longer do anything.
	final := rec.show
	switch {
	case final.State.Terminal():
	case reason == ipc.PromptCloseExpired:
		final.State = ipc.PromptStateExpired
	default:
		final.State = "" // withdrawn, superseded or closed undecided: nothing to show
	}
	if final.State == "" {
		inbox := h.inbox
		for _, pl := range rec.placements {
			id := listEntryID(rec.show.PromptID, pl.owner)
			ob.io(func() {
				if err := inbox.RetractPrompt(id); err != nil {
					h.log.Warn("prompt list entry not retracted", "id", id, "error", err.Error())
				}
			})
		}
		return
	}
	final.Actions = []ipc.PromptAction{}
	final.DefaultActionID = ""
	final.Timing.Expiry = nil
	rec.show = final
	h.persist(rec, now, ob)
}

func (h *Host) persist(rec *record, now time.Time, ob *outbox) {
	if h.inbox == nil || !rec.show.ListEntry.Persistent {
		return
	}
	expires := now.Add(listEntryTTL)
	if ms := rec.show.ListEntry.ExpiresAtUnixMs; ms > 0 {
		expires = time.UnixMilli(ms)
	}
	scope := ""
	if rec.show.IdentityRef != nil {
		scope = rec.show.IdentityRef.ScopeID
	}
	inbox := h.inbox
	seen := map[string]bool{}
	for _, pl := range rec.placements {
		e := ListEntry{
			ID:        listEntryID(rec.show.PromptID, pl.owner),
			PromptID:  rec.show.PromptID,
			OwnerKey:  pl.owner.PrincipalKey(),
			ScopeID:   scope,
			ExpiresAt: expires,
			Show:      rec.show,
		}
		if seen[e.ID] {
			continue // one principal in two sessions: one entry
		}
		seen[e.ID] = true
		ob.io(func() {
			if err := inbox.PutPrompt(e); err != nil {
				h.log.Warn("prompt list entry not persisted", "promptId", e.PromptID, "error", err.Error())
			}
		})
	}
}

// sortedRecords returns open prompts oldest first (deterministic ticks and
// "the oldest pending decision" on replay).
func (h *Host) sortedRecords() []*record {
	recs := make([]*record, 0, len(h.prompts))
	for _, r := range h.prompts {
		recs = append(recs, r)
	}
	sort.Slice(recs, func(i, j int) bool {
		if recs[i].createdAt.Equal(recs[j].createdAt) {
			return recs[i].show.PromptID < recs[j].show.PromptID
		}
		return recs[i].createdAt.Before(recs[j].createdAt)
	})
	return recs
}

// placementFor finds the placement whose current lease the renderer quoted.
func (r *record) placementFor(fromKey string, lease ipc.PromptLease) *placement {
	if lease.RendererSession != fromKey {
		return nil
	}
	for _, pl := range r.placements {
		if pl.path == PathPrompt && pl.renderer == fromKey && pl.epoch == lease.Epoch {
			return pl
		}
	}
	return nil
}

// handleRendererMessage handles a renderer -> agent prompt message from the
// broker session fromKey. prompt_action is answered (prompt_action_result).
func (h *Host) handleRendererMessage(fromKey, msgType string, raw json.RawMessage) (string, any) {
	switch msgType {
	case ipc.TypePromptPresented:
		var m ipc.PromptPresented
		if err := json.Unmarshal(raw, &m); err != nil {
			h.log.Warn("malformed prompt_presented from a renderer", "renderer", fromKey, "error", err.Error())
			return "", nil
		}
		h.onPresented(fromKey, m)
	case ipc.TypePromptClosed:
		var m ipc.PromptClosed
		if err := json.Unmarshal(raw, &m); err != nil {
			h.log.Warn("malformed prompt_closed from a renderer", "renderer", fromKey, "error", err.Error())
			return "", nil
		}
		h.onClosed(fromKey, m)
	case ipc.TypePromptAction:
		var m ipc.PromptActionRequest
		if err := json.Unmarshal(raw, &m); err != nil {
			h.log.Warn("malformed prompt_action from a renderer", "renderer", fromKey, "error", err.Error())
			return ipc.TypePromptActionResult, ipc.PromptActionResult{Result: ipc.PromptActionRejectedInvalid, Rev: 1}
		}
		return ipc.TypePromptActionResult, h.onAction(fromKey, m)
	default:
		h.log.Warn("unexpected prompt message type", "type", msgType, "renderer", fromKey)
	}
	return "", nil
}

func (h *Host) onPresented(fromKey string, m ipc.PromptPresented) {
	h.mu.Lock()
	defer h.mu.Unlock()
	rec := h.prompts[m.PromptID]
	if rec == nil {
		return
	}
	pl := rec.placementFor(fromKey, m.Lease)
	if pl == nil || m.Rev > rec.show.Rev {
		h.log.Debug("stale prompt_presented", "promptId", m.PromptID, "from", fromKey)
		return
	}
	now := h.clock.Now()
	pl.presented = true
	if rec.firstPresentedAt.IsZero() {
		rec.firstPresentedAt = now
	}
	h.log.Info("prompt presented", "promptId", m.PromptID, "kind", rec.show.Kind, "renderer", fromKey, "visible", m.Visible)
}

func (h *Host) onClosed(fromKey string, m ipc.PromptClosed) {
	ob := &outbox{}
	h.mu.Lock()
	rec := h.prompts[m.PromptID]
	var pl *placement
	if rec != nil {
		pl = rec.placementFor(fromKey, m.Lease)
	}
	if pl == nil {
		h.mu.Unlock()
		h.log.Debug("stale prompt_closed", "promptId", m.PromptID, "from", fromKey, "reason", m.Reason)
		return
	}
	switch m.Reason {
	case ipc.PromptClosedRenderFailed:
		h.log.Warn("renderer refused a prompt", "promptId", m.PromptID, "renderer", fromKey, "detail", m.Detail)
		h.fallback(rec, pl, h.clock.Now(), ob, "render_failed")
	case ipc.PromptClosedHidden:
		pl.hidden = true // hiding is never a domain action
	}
	h.unlockAndFlush(ob)
}

func (h *Host) onAction(fromKey string, m ipc.PromptActionRequest) ipc.PromptActionResult {
	h.actionMu.Lock()
	defer h.actionMu.Unlock()

	res := ipc.PromptActionResult{PromptID: m.PromptID, ActionID: m.ActionID, Rev: m.Rev}
	if res.Rev == 0 {
		res.Rev = 1
	}
	stale := func(msg string, args ...any) ipc.PromptActionResult {
		res.Result = ipc.PromptActionRejectedStale
		h.log.Debug(msg, append([]any{"promptId", m.PromptID, "action", m.ActionID, "from", fromKey}, args...)...)
		return res
	}
	invalid := func(level slog.Level, msg string) ipc.PromptActionResult {
		res.Result = ipc.PromptActionRejectedInvalid
		h.log.Log(context.Background(), level, msg, "promptId", m.PromptID, "action", m.ActionID, "rev", m.Rev, "from", fromKey)
		return res
	}

	h.mu.Lock()
	now := h.clock.Now()
	rec := h.prompts[m.PromptID]
	if rec == nil {
		h.mu.Unlock()
		return stale("action on a closed prompt")
	}
	res.Rev = rec.show.Rev
	pl := rec.placementFor(fromKey, m.Lease)
	if pl == nil {
		h.mu.Unlock()
		return stale("action on a stale lease")
	}
	key := actionKey{m.ActionID, m.Rev}
	if prior, ok := rec.results[key]; ok {
		h.mu.Unlock()
		return prior
	}
	if d := rec.deadline(); rec.expiryFired || (!d.IsZero() && !now.Before(d)) {
		h.mu.Unlock()
		return stale("action after the deadline")
	}
	switch {
	case m.Rev < rec.show.Rev, !rec.lingerUntil.IsZero(), rec.show.State.Terminal():
		h.mu.Unlock()
		return stale("action on a superseded rev", "current", rec.show.Rev)
	case m.Rev > rec.show.Rev:
		h.mu.Unlock()
		return invalid(slog.LevelDebug, "action on a rev the agent never sent")
	}
	offered := false
	for _, a := range rec.show.Actions {
		if a.ID == m.ActionID {
			offered = true
		}
	}
	next, hasNext := ipc.PromptState(""), false
	if t := rec.p.Kind.Transitions; t != nil {
		next, hasNext = t[rec.show.State][m.ActionID]
		offered = offered && hasNext
	}
	onAction, owner := rec.p.OnAction, pl.owner
	if !offered || onAction == nil {
		h.mu.Unlock()
		if onAction == nil {
			return invalid(slog.LevelWarn, "prompt has no action handler")
		}
		return invalid(slog.LevelWarn, "renderer sent an action the prompt does not offer in this state")
	}
	h.mu.Unlock()

	outcome, err := onAction(m.ActionID, owner)

	ob := &outbox{}
	h.mu.Lock()
	now = h.clock.Now()
	cur := h.prompts[m.PromptID]
	if cur != nil {
		res.Rev = cur.show.Rev
	}
	if err != nil {
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedInvalid
		h.log.Warn("prompt action failed", "promptId", m.PromptID, "action", m.ActionID, "error", err.Error())
		return res
	}
	if !outcome.Accepted {
		h.mu.Unlock()
		return invalid(slog.LevelDebug, "the domain refused a prompt action")
	}
	if cur != nil {
		patch := outcome.Patch
		if patch == nil && hasNext && next != cur.show.State {
			patch = &Patch{State: &next}
		}
		if patch != nil {
			if perr := h.applyPatch(cur, *patch, now, ob); perr != nil {
				h.log.Warn("prompt action patch refused", "promptId", m.PromptID, "error", perr.Error())
			}
		}
		res.Rev = cur.show.Rev
		if outcome.Close != nil {
			h.closeLocked(cur, *outcome.Close, now, ob)
		}
	}
	res.Result = ipc.PromptActionAccepted
	rec.results[key] = res
	h.unlockAndFlush(ob)
	h.log.Info("prompt action accepted", "promptId", m.PromptID, "action", m.ActionID, "via", m.Via, "renderer", fromKey)
	return res
}

// outbox collects work to run after mu is released: sends and inbox writes
// in order (under flushMu), then domain callbacks.
type outbox struct {
	steps []step
	calls []func()
}

type step struct {
	send *sendOp
	io   func()
}

type sendOp struct {
	key, msgType, kind, promptID string
	pl                           *placement
	epoch                        uint32
	payload                      any
}

func (o *outbox) send(key, msgType, kind, promptID string, pl *placement, payload any) {
	op := &sendOp{key: key, msgType: msgType, kind: kind, promptID: promptID, pl: pl, payload: payload}
	if pl != nil {
		op.epoch = pl.epoch
	}
	o.steps = append(o.steps, step{send: op})
}

func (o *outbox) io(f func()) { o.steps = append(o.steps, step{io: f}) }

func (o *outbox) call(f func()) { o.calls = append(o.calls, f) }

// unlockAndFlush hands the state lock over to the flush lock, so this
// outbox's sends leave before any later state change's, then runs the
// domain callbacks with no host lock held.
func (h *Host) unlockAndFlush(ob *outbox) {
	h.flushMu.Lock()
	h.mu.Unlock()
	var failed []*sendOp
	for _, st := range ob.steps {
		if st.io != nil {
			st.io()
			continue
		}
		s := st.send
		if err := h.dir.Send(s.key, s.msgType, s.kind, s.payload); err != nil {
			h.logSendFailure(s, err)
			if s.msgType == ipc.TypePromptShow && s.pl != nil {
				failed = append(failed, s)
			}
		}
	}
	h.flushMu.Unlock()
	if len(failed) > 0 {
		h.mu.Lock()
		for _, s := range failed {
			if rec := h.prompts[s.promptID]; rec != nil && s.pl.epoch == s.epoch && s.pl.path == PathPrompt {
				s.pl.sendFailed = true
			}
		}
		h.mu.Unlock()
	}
	for _, c := range ob.calls {
		c()
	}
}

func (h *Host) logSendFailure(s *sendOp, err error) {
	args := []any{"type", s.msgType, "promptId", s.promptID, "renderer", s.key, "error", err.Error()}
	switch {
	case errors.Is(err, sessionbroker.ErrPromptBadMessage):
		h.log.Error("prompt host built a message the broker refused", args...)
	case s.msgType == ipc.TypePromptClose && (errors.Is(err, sessionbroker.ErrPromptSessionGone) || errors.Is(err, errRendererGone)):
		h.log.Debug("prompt close to a renderer that is gone", args...)
	default:
		h.log.Warn("prompt send failed", args...)
	}
}
