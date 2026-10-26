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
)

var (
	// ErrTombstoned: the prompt was decided or closed in the last 24 h; it
	// is never drawn again.
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
}

// Host is the agent's prompt host. All methods are safe for concurrent use.
//
// Locking: mu guards all state and is never held across a send, a domain
// callback or an inbox write (those are queued in an outbox and run after
// unlock). actionMu serializes actions so OnAction runs outside mu yet two
// concurrent answers apply exactly one decision.
type Host struct {
	dir   RendererDirectory
	inbox PromptInbox
	clock Clock
	log   *slog.Logger

	actionMu sync.Mutex

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
// the same id (it never draws a second window).
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
		rev := rec.show.Rev + 1
		rec.p = p
		rec.show = p.Show
		rec.show.Rev = rev
		for _, pl := range rec.placements {
			if pl.path == PathPrompt && pl.renderer != "" {
				ob.send(pl.renderer, ipc.TypePromptShow, rec.show.Kind, rec.show.PromptID, pl, h.wireShow(rec, pl))
			}
		}
		h.addMissingOwners(rec, now, ob)
		h.persist(rec, now, ob)
		h.mu.Unlock()
		h.flush(ob)
		return nil
	}
	rec := &record{p: p, show: p.Show, createdAt: now, results: map[actionKey]ipc.PromptActionResult{}}
	rec.show.Rev = 1
	h.prompts[p.ID] = rec
	h.addMissingOwners(rec, now, ob)
	h.persist(rec, now, ob)
	h.mu.Unlock()
	h.flush(ob)
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
		h.place(rec, pl, now, ob)
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
	h.mu.Unlock()
	h.flush(ob)
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
	h.mu.Unlock()
	h.flush(ob)
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
func (h *Host) place(rec *record, pl *placement, now time.Time, ob *outbox) {
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
	h.assign(rec, pl, h.choose(rec, pl), now, ob)
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
func (h *Host) assign(rec *record, pl *placement, c Choice, now time.Time, ob *outbox) {
	pl.path = c.Path
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
		h.log.Info("prompt has no renderer", "promptId", rec.show.PromptID, "kind", rec.show.Kind, "owner", pl.owner.Key())
	}
}

func presentWithin(rec *record) time.Duration {
	if ms := rec.show.Timing.PresentWithinMs; ms > 0 {
		return time.Duration(ms) * time.Millisecond
	}
	return defaultPresentWithin
}

// wireShow is the prompt_show one placement's renderer receives.
func (h *Host) wireShow(rec *record, pl *placement) ipc.PromptShow {
	s := rec.show
	s.Facts = append([]ipc.PromptFact(nil), rec.show.Facts...)
	s.Actions = append([]ipc.PromptAction{}, rec.show.Actions...)
	s.Lease = pl.lease()
	s.KindVersion = pl.version
	s.Timing = rec.wireTiming()
	if pl.listOnly {
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
	h.assign(rec, pl, h.choose(rec, pl), now, ob)
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
	h.tombs.add(rec.show.PromptID, now)
	if h.inbox == nil || !rec.show.ListEntry.Persistent {
		return
	}
	switch reason {
	case ipc.PromptCloseWithdrawn, ipc.PromptCloseSuperseded, ipc.PromptCloseFenced:
		for _, pl := range rec.placements {
			id := listEntryID(rec.show.PromptID, pl.owner)
			ob.call(func() { h.inbox.RetractPrompt(id) })
		}
	default:
		// The outcome stays findable in the list until the entry expires.
		h.persist(rec, now, ob)
	}
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
	for _, pl := range rec.placements {
		e := ListEntry{
			ID:        listEntryID(rec.show.PromptID, pl.owner),
			PromptID:  rec.show.PromptID,
			OwnerKey:  pl.owner.Key(),
			ScopeID:   scope,
			ExpiresAt: expires,
			Show:      rec.show,
		}
		ob.call(func() {
			if err := h.inbox.PutPrompt(e); err != nil {
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
			h.log.Debug("malformed prompt_presented", "from", fromKey, "error", err.Error())
			return "", nil
		}
		h.onPresented(fromKey, m)
	case ipc.TypePromptClosed:
		var m ipc.PromptClosed
		if err := json.Unmarshal(raw, &m); err != nil {
			h.log.Debug("malformed prompt_closed", "from", fromKey, "error", err.Error())
			return "", nil
		}
		h.onClosed(fromKey, m)
	case ipc.TypePromptAction:
		var m ipc.PromptActionRequest
		if err := json.Unmarshal(raw, &m); err != nil {
			h.log.Debug("malformed prompt_action", "from", fromKey, "error", err.Error())
			return ipc.TypePromptActionResult, ipc.PromptActionResult{Result: ipc.PromptActionRejectedInvalid, Rev: 1}
		}
		return ipc.TypePromptActionResult, h.onAction(fromKey, m)
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
	h.mu.Unlock()
	h.flush(ob)
}

func (h *Host) onAction(fromKey string, m ipc.PromptActionRequest) ipc.PromptActionResult {
	h.actionMu.Lock()
	defer h.actionMu.Unlock()

	res := ipc.PromptActionResult{PromptID: m.PromptID, ActionID: m.ActionID, Rev: m.Rev}
	if res.Rev == 0 {
		res.Rev = 1
	}
	h.mu.Lock()
	rec := h.prompts[m.PromptID]
	if rec == nil {
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedStale
		h.log.Debug("action on a closed prompt", "promptId", m.PromptID, "action", m.ActionID)
		return res
	}
	pl := rec.placementFor(fromKey, m.Lease)
	if pl == nil {
		res.Rev = rec.show.Rev
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedStale
		h.log.Debug("action on a stale lease", "promptId", m.PromptID, "from", fromKey)
		return res
	}
	key := actionKey{m.ActionID, m.Rev}
	if prior, ok := rec.results[key]; ok {
		h.mu.Unlock()
		return prior
	}
	res.Rev = rec.show.Rev
	switch {
	case m.Rev < rec.show.Rev, !rec.lingerUntil.IsZero(), rec.show.State.Terminal():
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedStale
		h.log.Debug("action on a superseded rev", "promptId", m.PromptID, "rev", m.Rev, "current", rec.show.Rev)
		return res
	case m.Rev > rec.show.Rev:
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedInvalid
		return res
	}
	valid := false
	for _, a := range rec.show.Actions {
		if a.ID == m.ActionID {
			valid = true
		}
	}
	next, hasNext := ipc.PromptState(""), false
	if t := rec.p.Kind.Transitions; t != nil {
		next, hasNext = t[rec.show.State][m.ActionID]
		valid = valid && hasNext
	}
	onAction, owner := rec.p.OnAction, pl.owner
	if !valid || onAction == nil {
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedInvalid
		return res
	}
	h.mu.Unlock()

	outcome, err := onAction(m.ActionID, owner)

	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	cur := h.prompts[m.PromptID]
	if err != nil || !outcome.Accepted {
		if cur != nil {
			res.Rev = cur.show.Rev
		}
		h.mu.Unlock()
		res.Result = ipc.PromptActionRejectedInvalid
		if err != nil {
			h.log.Warn("prompt action failed", "promptId", m.PromptID, "action", m.ActionID, "error", err.Error())
		}
		return res
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
	h.mu.Unlock()
	h.flush(ob)
	h.log.Info("prompt action accepted", "promptId", m.PromptID, "action", m.ActionID, "via", m.Via, "renderer", fromKey)
	return res
}

// outbox collects sends and callbacks to run after mu is released.
type outbox struct {
	sends []sendOp
	calls []func()
}

type sendOp struct {
	key, msgType, kind, promptID string
	pl                           *placement
	epoch                        uint32
	payload                      any
}

func (o *outbox) send(key, msgType, kind, promptID string, pl *placement, payload any) {
	op := sendOp{key: key, msgType: msgType, kind: kind, promptID: promptID, pl: pl, payload: payload}
	if pl != nil {
		op.epoch = pl.epoch
	}
	o.sends = append(o.sends, op)
}

func (o *outbox) call(f func()) { o.calls = append(o.calls, f) }

func (h *Host) flush(ob *outbox) {
	for _, s := range ob.sends {
		if err := h.dir.Send(s.key, s.msgType, s.kind, s.payload); err != nil {
			h.log.Debug("prompt send failed", "type", s.msgType, "promptId", s.promptID, "renderer", s.key, "error", err.Error())
			if s.msgType == ipc.TypePromptShow && s.pl != nil {
				h.sendFailed(s.promptID, s.pl, s.epoch)
			}
		}
	}
	for _, c := range ob.calls {
		c()
	}
}

// sendFailed makes the next tick fall back a placement whose show never left.
func (h *Host) sendFailed(promptID string, pl *placement, epoch uint32) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if rec := h.prompts[promptID]; rec != nil && pl.epoch == epoch && pl.path == PathPrompt {
		pl.presentBy = time.Time{}
		pl.listOnly = false
	}
}
