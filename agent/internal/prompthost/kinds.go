package prompthost

import (
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// Kind registry, per-session copy and scope closing (#10190 W04).
//
// A prompt is live for one owner only when three switches are on
// (compatibility order step 2): the agent build constructs the kind
// (RegisterKind, from agent/internal/promptkinds), the chosen renderer
// advertised kind@n at its live authentication, and the server lists the
// kind in promptHost.enabledKinds. PromptPathAvailable answers that question
// for a call site that must pick between the prompt host and its exact
// legacy call before it builds anything.

// RegisterKind records a kind this agent build constructs. Registering the
// same name and version again replaces the spec.
func (h *Host) RegisterKind(spec KindSpec) {
	if spec.Name == "" || spec.Version < 1 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.kinds[spec.Name] == nil {
		h.kinds[spec.Name] = map[int]KindSpec{}
	}
	h.kinds[spec.Name][spec.Version] = spec
}

// KindLive reports whether this build speaks kind@version and the server's
// kill switch enables it (two of the three switches; the renderer's
// advertisement is per session, see PromptPathAvailable).
func (h *Host) KindLive(kind string, version int) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, speaks := h.kinds[kind][version]
	return speaks && h.enabled.allows(kind, version)
}

// PromptPathAvailable reports whether a kind@version prompt for o would be
// drawn through the prompt contract right now: the build speaks it, the
// server enables it, and a live renderer serving o advertised it. When it is
// false the caller takes its exact legacy call.
func (h *Host) PromptPathAvailable(kind string, version int, o Owner) bool {
	h.mu.Lock()
	_, speaks := h.kinds[kind][version]
	enabled := h.enabled
	h.mu.Unlock()
	if !speaks {
		return false
	}
	c := selectRenderer(kind, []int{version}, h.dir.Renderers(o), enabled, nil, false, false)
	return c.Path == PathPrompt
}

// IsOpen reports whether a prompt is open (shown and not yet closed; a
// decided prompt in its terminal linger is not open). A caller that re-reports
// the same condition uses it so it does not re-send a prompt still on screen.
func (h *Host) IsOpen(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	rec := h.prompts[id]
	return rec != nil && rec.lingerUntil.IsZero()
}

// CloseScope closes every open prompt created under the MSP scope scopeID
// (its identityRef), on every renderer, and returns how many it closed. The
// heartbeat calls it when the device leaves that scope (org move, partner
// change): an open prompt must not keep showing the old MSP's identity, and
// its list entries go with it. An empty scope closes nothing.
func (h *Host) CloseScope(scopeID string, reason ipc.PromptCloseReason) int {
	if scopeID == "" {
		return 0
	}
	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	n := 0
	for _, rec := range h.sortedRecords() {
		if ref := rec.show.IdentityRef; ref != nil && ref.ScopeID == scopeID {
			h.closeLocked(rec, reason, now, ob)
			n++
		}
	}
	h.unlockAndFlush(ob)
	return n
}

// placementLocale is the catalog locale one placement's copy is rendered
// in: its renderer's session locale on the prompt path; otherwise the
// machine's UI language, then en (the agent fallback, Todd decision 5).
func (h *Host) placementLocale(c Choice) promptcatalog.Locale {
	if c.Path == PathPrompt {
		return h.SessionLocale(c.Renderer)
	}
	return h.SessionLocale(RendererSession{})
}

// localize returns s with the prompt's locale-dependent content rendered in
// loc. Without a Localize callback, or with no locale yet, s is returned as
// built. A Localize error keeps the content as built (logged): a prompt in
// the build's language beats no prompt.
func (h *Host) localize(rec *record, s ipc.PromptShow, loc promptcatalog.Locale) ipc.PromptShow {
	if rec.p.Localize == nil || loc == "" {
		return s
	}
	l, err := rec.p.Localize(loc)
	if err != nil {
		h.log.Warn("prompt copy not localized; sending it as built", "promptId", rec.show.PromptID, "locale", string(loc), "error", err.Error())
		return s
	}
	s.Copy = l.Copy
	s.Facts = append([]ipc.PromptFact(nil), l.Facts...)
	actions := make([]ipc.PromptAction, len(s.Actions))
	for i, a := range s.Actions {
		if label, ok := l.ActionLabels[a.ID]; ok && label != "" {
			a.Label = label
		}
		actions[i] = a
	}
	s.Actions = actions
	if l.ExpiryText != "" && s.Timing.Expiry != nil {
		e := *s.Timing.Expiry // never write through the record's pointer
		e.Text = l.ExpiryText
		s.Timing.Expiry = &e
	}
	s.Locale = string(loc)
	return s
}

// relocalizeUpdate renders a Relocalize patch's copy, facts, action labels
// and expiry text in the placement's locale, from the merged show.
func (h *Host) relocalizeUpdate(rec *record, pl *placement, u *ipc.PromptUpdate) {
	if rec.p.Localize == nil || pl.locale == "" {
		return
	}
	s := h.localize(rec, rec.show, pl.locale)
	if u.Copy != nil {
		c := s.Copy
		u.Copy = &c
	}
	if u.Facts != nil {
		f := append([]ipc.PromptFact(nil), s.Facts...)
		u.Facts = &f
	}
	if u.Actions != nil {
		a := append([]ipc.PromptAction{}, s.Actions...)
		u.Actions = &a
	}
	if u.Timing != nil && u.Timing.Expiry != nil && s.Timing.Expiry != nil {
		t := *u.Timing
		e := *t.Expiry
		e.Text = s.Timing.Expiry.Text
		t.Expiry = &e
		u.Timing = &t
	}
}
