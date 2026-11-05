package prompthost

import (
	"encoding/base64"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/promptidentity"
)

// Branding sync and session locale (#10190 W03, spec §3.1 / §3.6, plan P6).
//
// prompt_branding_sync carries the MSP identity the renderer draws in its
// header — it is the only source of that header; prompt payloads cannot set
// it — plus the session's negotiated locale for the renderer's own chrome.
// It goes to every session holding a prompt scope, on connect (before any
// replayed prompt) and whenever the identity changes. In W03 no renderer
// advertises a kind, so no session holds a prompt scope and nothing is sent.

// IdentitySource is the agent's MSP identity cache (promptidentity.Store).
type IdentitySource interface {
	Current() (promptidentity.Identity, bool)
}

// promptRendererLister is implemented by directories that can list every
// prompt-scoped renderer (BrokerDirectory).
type promptRendererLister interface {
	PromptRenderers() []RendererSession
}

// localeBorrower finds a user-context session's UI language in a Windows
// session (BrokerDirectory); the SYSTEM helper borrows it.
type localeBorrower interface {
	UserLocaleInWinSession(winSession uint32) string
}

// genericIdentityName is the last resort if the catalog cannot render
// common/identity.generic (it always can; the embed is checked by tests).
const genericIdentityName = "your IT support team"

// SessionLocale is the catalog locale for strings rendered for a renderer's
// session: its reported UI language, negotiated; for the SYSTEM helper
// (which runs as SYSTEM) a user-context session's language in the same
// Windows session first; then the machine's UI language; then en.
func (h *Host) SessionLocale(r RendererSession) promptcatalog.Locale {
	if r.Role == ipc.HelperRoleSystem {
		if b, ok := h.dir.(localeBorrower); ok {
			if tag := strings.TrimSpace(b.UserLocaleInWinSession(r.Owner.WinSessionID)); tag != "" {
				return promptcatalog.Negotiate(tag)
			}
		}
	}
	if tag := strings.TrimSpace(r.UILocale); tag != "" {
		return promptcatalog.Negotiate(tag)
	}
	if h.osLocale != nil {
		if tag := strings.TrimSpace(h.osLocale()); tag != "" {
			return promptcatalog.Negotiate(tag)
		}
	}
	return promptcatalog.LocaleEN
}

// brandingSync builds the message for one renderer. Called without mu (it
// reads the identity cache and, for the SYSTEM helper, the broker).
func (h *Host) brandingSync(r RendererSession) ipc.PromptBrandingSync {
	loc := h.SessionLocale(r)
	var (
		id promptidentity.Identity
		ok bool
	)
	if h.identity != nil {
		id, ok = h.identity.Current()
	}
	if !ok {
		return ipc.PromptBrandingSync{Cleared: true, Locale: string(loc)}
	}
	name := id.PartnerName
	if name == "" {
		// The W02 schema requires a name: send the localized generic one.
		var err error
		if name, err = promptcatalog.Render(loc, "common", "identity.generic", nil); err != nil || name == "" {
			name = genericIdentityName
		}
	}
	b := ipc.PromptBrandingSync{
		ScopeID:      id.ScopeID,
		PartnerName:  name,
		PrimaryColor: id.PrimaryColor,
		Locale:       string(loc),
	}
	if l := id.Logo; l != nil && len(l.Data) > 0 {
		b.Logo = &ipc.PromptLogo{Sha256: l.Sha256, Mime: l.Mime, Bytes: len(l.Data), Data: base64.StdEncoding.EncodeToString(l.Data)}
	}
	return b
}

// queueBrandingSync queues a branding sync to r on the outbox. The message
// is built when the outbox flushes (outside mu, in order with the sends
// around it).
func (h *Host) queueBrandingSync(r RendererSession, ob *outbox) {
	ob.io(func() { h.sendBrandingSync(r) })
}

func (h *Host) sendBrandingSync(r RendererSession) {
	if err := h.dir.Send(r.Key, ipc.TypePromptBrandingSync, "", h.brandingSync(r)); err != nil {
		h.logSendFailure(&sendOp{key: r.Key, msgType: ipc.TypePromptBrandingSync}, err)
	}
}

// IdentityChanged sends the current identity to every prompt-scoped
// renderer. The heartbeat calls it after the identity cache changed (a new
// block, or a logo that finished downloading).
func (h *Host) IdentityChanged() {
	lister, ok := h.dir.(promptRendererLister)
	if !ok {
		return
	}
	ob := &outbox{}
	for _, r := range lister.PromptRenderers() {
		h.queueBrandingSync(r, ob)
	}
	if len(ob.steps) == 0 {
		return
	}
	h.mu.Lock()
	h.unlockAndFlush(ob)
}
