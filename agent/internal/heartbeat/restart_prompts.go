package heartbeat

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/patching"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptidentity"
	"github.com/breeze-rmm/agent/internal/promptkinds"
)

// The restart card (#10190 W05, plan Task 5.1, spec §3.3; closes #10181).
//
// restartCard is the reboot manager's RestartSurface: each warning rung is
// offered here first. A rung is drawn on the card only for the sessions where
// all three switches are on (this build speaks restart.prompt /
// restart.final, the session's renderer advertised it at its live
// authentication, and the server lists it in promptHost.enabledKinds). When
// no session qualifies, the rung is declined and the manager sends today's
// warning — the same toast or Yes/No box as before — to every session.
//
// A device whose sessions are split (one session draws the card, another
// runs a helper that predates W05) is transitional: the card sessions get
// the card, the others get this rung's warning as a toast, one session at a
// time. They do not get today's Postpone dialog there; the restart still
// happens at its time and they are still told (#3197).
//
// Lock order: the manager calls ShowRung / Cancelled / BeforeOSRestart with
// no manager lock held; restartCard.mu is taken before any host call and the
// host never calls back into it. A decision (prompthost OnActionRenderer,
// under the host's action lock) calls the manager, whose re-plan arms the
// next rung on its own timer goroutine — never inline.

// restartDecider is the reboot manager's decision surface.
type restartDecider interface {
	UserPostpone(campaign uint64, renderer string) error
	UserRestartNow(campaign uint64, renderer string) error
	RestartRungNow(campaign uint64) (patching.RestartRung, bool)
}

type restartCard struct {
	host *prompthost.Host
	mgr  restartDecider
	// owners lists one owner per interactive session (the notify targets).
	owners func() []prompthost.Owner
	// notify sends today's toast to one owner's session.
	notify func(o prompthost.Owner, req ipc.NotifyRequest) error
	// settled runs f with the MSP identity while no scope change is in
	// progress (promptidentity.Store.WithSettledIdentity); nil = no identity.
	settled func(f func(id promptidentity.Identity, ok bool))

	mu       sync.Mutex
	campaign uint64
	// cancelled is the last campaign an operator cancelled: a rung of it that
	// was already past the manager's checks when the cancel landed must not
	// draw a card nobody can act on.
	cancelled uint64
	// placed are the owners the current campaign's card was drawn for: they
	// get the after-restart entry.
	placed map[string]prompthost.Owner

	// legacyMu guards lastLegacy: the newest rung's warning, kept for a card
	// rebuilt after a postponement (RestartRungNow carries no rung copy), so
	// its fallback still says something (#3197). Separate from mu because a
	// decision reads it under the host's action lock.
	legacyMu   sync.Mutex
	lastLegacy map[uint64]ipc.NotifyRequest
}

var _ patching.RestartSurface = (*restartCard)(nil)

// newRestartCard wires the card over this heartbeat's prompt host, broker,
// identity cache and reboot manager. Nil when any of them is missing.
func (h *Heartbeat) newRestartCard() *restartCard {
	if h.promptHost == nil || h.sessionBroker == nil || h.rebootMgr == nil {
		return nil
	}
	c := &restartCard{
		host:   h.promptHost,
		mgr:    h.rebootMgr,
		owners: func() []prompthost.Owner { return noticeOwnersOf(h.sessionBroker.NotifyTargetsExcept("")) },
		notify: h.notifyOwner,
	}
	if h.promptIdentity != nil {
		c.settled = h.promptIdentity.WithSettledIdentity
	}
	return c
}

func (c *restartCard) prompts() promptkinds.RestartPrompts {
	return promptkinds.RestartPrompts{
		Postpone: func(campaign uint64, renderer string) (promptkinds.RestartPromptInput, bool, error) {
			if err := c.mgr.UserPostpone(campaign, renderer); err != nil {
				return promptkinds.RestartPromptInput{}, false, err
			}
			rung, ok := c.mgr.RestartRungNow(campaign)
			if !ok {
				// Applied, then replaced or cancelled before it could be read
				// back: the postponement stands; the card is not refreshed.
				return promptkinds.RestartPromptInput{}, false, nil
			}
			return c.input(rung), true, nil
		},
		RestartNow: c.mgr.UserRestartNow,
		Refresh:    c.host.Refresh,
		Notify:     c.notify,
	}
}

// identity returns the MSP name the card names ("" = generic).
func (c *restartCard) partner() string {
	name := ""
	if c.settled != nil {
		c.settled(func(id promptidentity.Identity, ok bool) {
			if ok {
				name = id.PartnerName
			}
		})
	}
	return name
}

func (c *restartCard) input(r patching.RestartRung) promptkinds.RestartPromptInput {
	legacy := ipc.NotifyRequest{Title: r.LegacyTitle, Body: r.LegacyBody, Urgency: r.LegacyUrgency}
	c.legacyMu.Lock()
	if legacy.Title != "" || legacy.Body != "" {
		if c.lastLegacy == nil || len(c.lastLegacy) > 4 {
			c.lastLegacy = map[uint64]ipc.NotifyRequest{}
		}
		c.lastLegacy[r.Campaign] = legacy
	} else {
		legacy = c.lastLegacy[r.Campaign]
	}
	c.legacyMu.Unlock()
	return promptkinds.RestartPromptInput{
		Campaign:        r.Campaign,
		ScheduledAt:     r.ScheduledAt,
		PostponeUntil:   r.PostponeUntil,
		DeferralAllowed: r.DeferralAllowed,
		DeferralsLeft:   r.DeferralsLeft,
		OperatorTitle:   r.Text.Title,
		OperatorBody:    r.Text.Body,
		OperatorButton:  r.Text.Button,
		Partner:         c.partner(),
		Legacy:          legacy,
	}
}

// ShowRung implements patching.RestartSurface.
func (c *restartCard) ShowRung(r patching.RestartRung) bool {
	if r.Campaign == 0 {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if r.Campaign == c.cancelled {
		// The operator cancelled while this rung was on its way: handled,
		// with nothing to show. Declining would make the manager send a
		// warning (or a Restart now dialog) for a restart that is off.
		return true
	}
	if c.campaign != r.Campaign {
		// A new operator schedule replaces the old campaign's cards (and an
		// after-restart entry of an old campaign whose OS countdown it
		// aborted).
		c.closeCampaignLocked(ipc.PromptCloseSuperseded)
		c.forgetRestartedLocked()
		c.campaign = r.Campaign
		c.placed = map[string]prompthost.Owner{}
	}
	rs := c.prompts()
	kind := promptkinds.RestartPromptKind
	if r.Final {
		// The closing card takes over; the card it replaces leaves the list
		// (a decided one stays as its outcome).
		c.closeQuietly(promptkinds.RestartPromptID(r.Campaign), ipc.PromptCloseSuperseded)
		kind = promptkinds.RestartFinalKind
	}
	var onCard, legacy []prompthost.Owner
	for _, o := range c.owners() {
		if c.host.PromptPathAvailable(kind.Name, kind.Version, o) {
			onCard = append(onCard, o)
		} else {
			legacy = append(legacy, o)
		}
	}
	if len(onCard) == 0 {
		return false // today's warning, to every session
	}
	in := c.input(r)
	var p prompthost.Prompt
	if r.Final {
		p = rs.RestartFinal(r.Campaign, r.ScheduledAt, in.Legacy)
	} else {
		p = rs.RestartPrompt(in)
	}
	p.Owners = onCard
	var err error
	show := func() {
		if !r.Final && !r.Resurface && c.host.IsOpen(p.ID) {
			// The lead rung a postponement re-planned (#4941): the card the
			// person just answered is updated where it is, not re-opened.
			err = c.host.Refresh(p)
			return
		}
		err = c.host.Show(p)
	}
	if c.settled != nil {
		c.settled(func(id promptidentity.Identity, ok bool) {
			stampIdentity(&p, id, ok)
			show()
		})
	} else {
		show()
	}
	if err != nil {
		log.Error("restart card not shown; sending today's restart warning", "promptId", p.ID, "error", err.Error())
		return false
	}
	for _, o := range onCard {
		c.placed[o.PrincipalKey()] = o
	}
	for _, o := range legacy {
		if err := c.notify(o, in.Legacy); err != nil {
			log.Error("restart warning not delivered to a session without the card", "campaign", r.Campaign, "final", r.Final, "owner", o.Key(), "error", err.Error())
		}
	}
	return true
}

// Cancelled implements patching.RestartSurface: an operator cancelled the
// restart. The open card becomes "Restart cancelled by <MSP>", lingers, and
// stays in the list as that outcome.
func (c *restartCard) Cancelled(campaign uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if campaign == 0 {
		return
	}
	c.cancelled = campaign
	if campaign != c.campaign {
		return
	}
	rs := c.prompts()
	partner := c.partner()
	for _, card := range []struct {
		id   string
		kind prompthost.KindSpec
	}{
		{promptkinds.RestartPromptID(campaign), promptkinds.RestartPromptKind},
		{promptkinds.RestartFinalID(campaign), promptkinds.RestartFinalKind},
	} {
		if !c.host.IsOpen(card.id) {
			continue
		}
		if err := c.host.Refresh(rs.RestartCancelled(card.id, card.kind, partner)); err != nil {
			log.Warn("restart card not withdrawn as cancelled; closing it", "promptId", card.id, "error", err.Error())
			c.closeQuietly(card.id, ipc.PromptCloseWithdrawn)
		}
	}
	// Cancelled in the OS grace minute: the machine is not restarting after
	// all, so "Your computer restarted at …" must not be left behind.
	c.forgetRestartedLocked()
	c.placed = map[string]prompthost.Owner{}
}

// OSRestartFailed implements patching.RestartSurface: the OS restart command
// failed after the after-restart entry was written.
func (c *restartCard) OSRestartFailed(campaign uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if campaign != c.campaign {
		return
	}
	c.forgetRestartedLocked()
}

// forgetRestartedLocked retracts the current campaign's after-restart entry
// (a no-op when none was written). Callers hold c.mu.
func (c *restartCard) forgetRestartedLocked() {
	if c.campaign == 0 || len(c.placed) == 0 {
		return
	}
	owners := make([]prompthost.Owner, 0, len(c.placed))
	for _, o := range c.placed {
		owners = append(owners, o)
	}
	if err := c.host.RemoveFinished(promptkinds.RestartedNoticeID(c.campaign), owners); err != nil {
		log.Error("after-restart list entry not withdrawn", "campaign", c.campaign, "error", err.Error())
	}
}

// BeforeOSRestart implements patching.RestartSurface: every person the card
// was drawn for gets "Your computer restarted at <time>" in their list, shown
// list-only at their next sign-in.
func (c *restartCard) BeforeOSRestart(campaign uint64, at time.Time) {
	c.mu.Lock()
	owners := make([]prompthost.Owner, 0, len(c.placed))
	if campaign == c.campaign {
		for _, o := range c.placed {
			owners = append(owners, o)
		}
	}
	c.mu.Unlock()
	if len(owners) == 0 {
		return
	}
	p := c.prompts().RestartedNotice(campaign, at)
	p.Owners = owners
	if c.settled != nil {
		c.settled(func(id promptidentity.Identity, ok bool) { stampIdentity(&p, id, ok) })
	}
	if err := c.host.RecordFinished(p); err != nil {
		log.Error("after-restart list entry not written", "promptId", p.ID, "owners", len(owners), "error", err.Error())
	}
}

func (c *restartCard) closeCampaignLocked(reason ipc.PromptCloseReason) {
	if c.campaign == 0 {
		return
	}
	c.closeQuietly(promptkinds.RestartPromptID(c.campaign), reason)
	c.closeQuietly(promptkinds.RestartFinalID(c.campaign), reason)
}

func (c *restartCard) closeQuietly(id string, reason ipc.PromptCloseReason) {
	if err := c.host.Close(id, reason); err != nil && !errors.Is(err, prompthost.ErrUnknownPrompt) {
		log.Warn("restart card not closed", "promptId", id, "reason", string(reason), "error", fmt.Sprint(err))
	}
}

// promptSessionLockChanged forwards a Windows session lock / unlock to the
// prompt host.
func (h *Heartbeat) promptSessionLockChanged(winSession uint32, locked bool) {
	host := h.promptHost
	if host == nil {
		return
	}
	ev := prompthost.SessionUnlocked
	if locked {
		ev = prompthost.SessionLocked
	}
	host.SessionStateChanged(winSession, ev)
}
