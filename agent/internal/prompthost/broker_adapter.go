package prompthost

import (
	"encoding/json"
	"runtime"
	"strconv"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// The Host is the broker's prompt sink and session observer.
var (
	_ sessionbroker.PromptSink            = (*Host)(nil)
	_ sessionbroker.PromptSessionObserver = (*Host)(nil)
)

// HandleRendererMessage satisfies sessionbroker.PromptSink. The broker has
// already checked that s holds a prompt scope; the host checks the lease.
func (h *Host) HandleRendererMessage(s *sessionbroker.Session, msgType string, raw json.RawMessage) (string, any) {
	return h.handleRendererMessage(s.SessionID, msgType, raw)
}

// PromptRendererConnected satisfies sessionbroker.PromptSessionObserver.
func (h *Host) PromptRendererConnected(s *sessionbroker.Session) {
	h.RendererConnected(RendererFromSession(s, runtime.GOOS))
}

// PromptRendererDisconnected satisfies sessionbroker.PromptSessionObserver.
func (h *Host) PromptRendererDisconnected(s *sessionbroker.Session) {
	h.RendererDisconnected(s.SessionID)
}

// BrokerDirectory is the production RendererDirectory over the session broker.
type BrokerDirectory struct {
	b    *sessionbroker.Broker
	goos string
}

// NewBrokerDirectory adapts a broker for the host.
func NewBrokerDirectory(b *sessionbroker.Broker) *BrokerDirectory {
	return &BrokerDirectory{b: b, goos: runtime.GOOS}
}

// Renderers returns the live prompt-capable renderers serving the owner,
// read from each session's live authentication (never server-side records).
func (d *BrokerDirectory) Renderers(o Owner) []RendererSession {
	seen := map[string]bool{}
	var out []RendererSession
	for _, scope := range []string{ipc.ScopePrompt, ipc.ScopePromptOperator} {
		for _, s := range d.b.SessionsWithScope(scope) {
			if seen[s.SessionID] {
				continue
			}
			seen[s.SessionID] = true
			if r := RendererFromSession(s, d.goos); rendererServes(r, o) {
				out = append(out, r)
			}
		}
	}
	return out
}

// PromptRenderers returns every live renderer holding a prompt scope (the
// sessions a prompt_branding_sync may go to).
func (d *BrokerDirectory) PromptRenderers() []RendererSession {
	seen := map[string]bool{}
	var out []RendererSession
	for _, scope := range []string{ipc.ScopePrompt, ipc.ScopePromptOperator} {
		for _, s := range d.b.SessionsWithScope(scope) {
			if !seen[s.SessionID] {
				seen[s.SessionID] = true
				out = append(out, RendererFromSession(s, d.goos))
			}
		}
	}
	return out
}

// UserLocaleInWinSession is the UI language of a user-context helper in that
// Windows session (the SYSTEM helper borrows it).
func (d *BrokerDirectory) UserLocaleInWinSession(winSession uint32) string {
	if winSession == 0 {
		return ""
	}
	return d.b.UILocaleInWinSession(strconv.FormatUint(uint64(winSession), 10))
}

// Send delivers through the broker's scope-checked SendPrompt.
func (d *BrokerDirectory) Send(sessionKey, msgType, kind string, payload any) error {
	return d.b.SendPrompt(sessionKey, msgType, kind, payload)
}

// RendererFromSession builds the host's view of a broker session.
func RendererFromSession(s *sessionbroker.Session, goos string) RendererSession {
	r := RendererSession{
		Key:         s.SessionID,
		Role:        s.HelperRole,
		Protocol:    s.PromptProtocol(),
		KindAds:     s.PromptKindAds(),
		Version:     s.RendererVersion(),
		ConnectedAt: s.ConnectedAt,
		UILocale:    s.UILocale(),
	}
	if goos == "windows" {
		ws, _ := strconv.ParseUint(s.WinSessionID, 10, 32)
		r.Owner = Owner{WinSessionID: uint32(ws), UserSID: principalSID(s.IdentityKey)}
	} else {
		r.Owner = Owner{UID: int(s.UID)}
	}
	return r
}

// principalSID extracts the user SID from a broker identity key. Lifecycle
// roles carry "windows:<SID>:session:<n>"; every other role carries the SID.
func principalSID(identityKey string) string {
	if rest, ok := strings.CutPrefix(identityKey, "windows:"); ok {
		if i := strings.Index(rest, ":session:"); i >= 0 {
			return rest[:i]
		}
	}
	return identityKey
}
