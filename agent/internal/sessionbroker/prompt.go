package sessionbroker

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Prompt host routing (#10190). The broker enforces the trust boundary: a
// prompt kind is sent only over a session that advertised it at its live
// authentication and holds the kind's scope (prompt for Breeze-owned kinds,
// prompt_operator for kinds that may carry MSP copy). Renderer messages
// reach the PromptSink only from sessions holding a prompt scope.

var (
	// ErrPromptScopeMissing: the session did not advertise this kind (at
	// this version) or lacks the kind's scope. The caller falls back to the
	// legacy path.
	ErrPromptScopeMissing = errors.New("sessionbroker: prompt kind not granted to this session")
	// ErrPromptSessionGone: no connected session has that id.
	ErrPromptSessionGone = errors.New("sessionbroker: prompt renderer session is not connected")
	// ErrPromptBadMessage: the message type or payload does not match the
	// routing arguments.
	ErrPromptBadMessage = errors.New("sessionbroker: malformed prompt message")
)

// PromptSink receives renderer -> agent prompt messages (prompt_presented,
// prompt_action, prompt_closed) from sessions holding a prompt scope. A
// non-empty reply type is sent back on the request's envelope id
// (prompt_action -> prompt_action_result).
type PromptSink interface {
	HandleRendererMessage(s *Session, msgType string, raw json.RawMessage) (replyType string, reply any)
}

// PromptSessionObserver is optionally implemented by a PromptSink to learn
// when a prompt-capable renderer connects or disconnects. Both callbacks
// must return quickly; they run on the broker's connection goroutines.
type PromptSessionObserver interface {
	PromptRendererConnected(s *Session)
	PromptRendererDisconnected(s *Session)
}

// SetPromptSink installs the prompt host. Nil disables prompt routing.
func (b *Broker) SetPromptSink(sink PromptSink) {
	b.mu.Lock()
	b.promptSink = sink
	b.mu.Unlock()
}

func (b *Broker) loadPromptSink() PromptSink {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.promptSink
}

// promptKindAllowedForRole: assist may draw any kind; the user-role helper
// any kind except elevation.request; the SYSTEM helper only
// elevation.request (it owns the input-desktop UAC window). Every other role
// renders nothing.
func promptKindAllowedForRole(role ipc.HelperRole, kind string) bool {
	switch role {
	case ipc.HelperRoleAssist:
		return true
	case ipc.HelperRoleUser:
		return kind != "elevation.request"
	case ipc.HelperRoleSystem:
		return kind == "elevation.request"
	}
	return false
}

type promptGrant struct {
	protocol        int
	kinds           []string // granted "<kind>@<n>", deduped, advertised order
	scopes          []string
	rendererVersion string
}

// promptGrantFromAuth computes what a renderer gets from its advertisement.
// Pure: grantScopes (before the session exists) and applyAuthAdvertisements
// (on the session) both call it, so the scopes and the recorded kinds can
// never disagree. Unknown, malformed, role-forbidden and excess entries are
// ignored; a renderer that advertised no protocol version gets nothing.
func promptGrantFromAuth(role ipc.HelperRole, authReq ipc.AuthRequest) promptGrant {
	if authReq.PromptProtocolVersion < 1 {
		return promptGrant{}
	}
	g := promptGrant{protocol: authReq.PromptProtocolVersion}
	if g.protocol > ipc.PromptProtocolVersion {
		g.protocol = ipc.PromptProtocolVersion
	}
	g.rendererVersion = capCodePoints(strings.TrimSpace(authReq.RendererVersion), 32)
	seen := map[string]struct{}{}
	var wantPrompt, wantOperator bool
	for i, ad := range authReq.PromptKinds {
		if i >= ipc.MaxAdvertisedPromptKinds {
			break
		}
		name, _, ok := ipc.ParsePromptKindAd(ad)
		if !ok || !promptKindAllowedForRole(role, name) {
			continue
		}
		scope, known := ipc.PromptKindScope(name)
		if !known {
			continue
		}
		if _, dup := seen[ad]; dup {
			continue
		}
		seen[ad] = struct{}{}
		g.kinds = append(g.kinds, ad)
		if scope == ipc.ScopePromptOperator {
			wantOperator = true
		} else {
			wantPrompt = true
		}
	}
	if wantPrompt {
		g.scopes = append(g.scopes, ipc.ScopePrompt)
	}
	if wantOperator {
		g.scopes = append(g.scopes, ipc.ScopePromptOperator)
	}
	return g
}

// capCodePoints keeps at most n code points, never splitting one and never
// adding a suffix (the API caps rendererVersion at 32 code points and drops
// an over-long observation whole).
func capCodePoints(v string, n int) string {
	if utf8.RuneCountInString(v) <= n {
		return v
	}
	return string([]rune(v)[:n])
}

// ApplyPromptAuthForTest records a prompt advertisement on a session built
// outside the auth path, exactly as the auth path would (tests in other
// packages).
func (s *Session) ApplyPromptAuthForTest(role ipc.HelperRole, authReq ipc.AuthRequest) {
	g := promptGrantFromAuth(role, authReq)
	applyPromptGrant(s, g)
	s.uiLocale = uiLocaleFromAuth(authReq)
	s.AllowedScopes = append(append([]string(nil), s.AllowedScopes...), g.scopes...)
}

func applyPromptGrant(s *Session, g promptGrant) {
	s.promptProtocol = g.protocol
	s.promptKinds = g.kinds
	s.rendererVersion = g.rendererVersion
}

// maxUILocaleLen matches the shared localeSchema cap (35).
const maxUILocaleLen = 35

// uiLocaleFromAuth keeps a helper-reported UI language only when it looks
// like a language tag (BCP 47 or POSIX: ASCII letters, digits, '-', '_',
// '.', '@', at most 35 bytes). Anything else is dropped (= unknown). The
// prompt host negotiates what is kept, so it never reaches a renderer
// verbatim.
func uiLocaleFromAuth(authReq ipc.AuthRequest) string {
	v := strings.TrimSpace(authReq.UILocale)
	if v == "" || len(v) > maxUILocaleLen {
		return ""
	}
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r == '@':
		default:
			return ""
		}
	}
	return v
}

// UILocale is the UI language this helper reported at auth ("" = unknown).
func (s *Session) UILocale() string { return s.uiLocale }

// UILocaleInWinSession returns the UI language of a user-context session
// (any role but SYSTEM) in the given Windows session, preferring the most
// recently connected one, or "". The SYSTEM helper runs as SYSTEM, so its
// own probe reports the machine language, not the signed-in user's.
func (b *Broker) UILocaleInWinSession(winSessionID string) string {
	if winSessionID == "" {
		return ""
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	var best *Session
	for _, s := range b.sessions {
		if s.HelperRole == ipc.HelperRoleSystem || s.WinSessionID != winSessionID || s.uiLocale == "" {
			continue
		}
		if best == nil || s.ConnectedAt.After(best.ConnectedAt) || (s.ConnectedAt.Equal(best.ConnectedAt) && s.SessionID > best.SessionID) {
			best = s
		}
	}
	if best == nil {
		return ""
	}
	return best.uiLocale
}

// PromptProtocol is the clamped prompt protocol this renderer speaks (0 = none).
func (s *Session) PromptProtocol() int { return s.promptProtocol }

// RendererVersion is the renderer build version the helper advertised.
func (s *Session) RendererVersion() string { return s.rendererVersion }

// PromptKindAds returns a copy of the granted "<kind>@<n>" advertisements.
func (s *Session) PromptKindAds() []string {
	return append([]string(nil), s.promptKinds...)
}

// PromptKindVersion returns the highest granted version of kind.
func (s *Session) PromptKindVersion(kind string) (int, bool) {
	best := 0
	for _, ad := range s.promptKinds {
		if name, v, ok := ipc.ParsePromptKindAd(ad); ok && name == kind && v > best {
			best = v
		}
	}
	return best, best > 0
}

func (s *Session) promptKindHasVersion(kind string, version int) bool {
	for _, ad := range s.promptKinds {
		if name, v, ok := ipc.ParsePromptKindAd(ad); ok && name == kind && v == version {
			return true
		}
	}
	return false
}

// HasPromptScope reports whether the session holds either prompt scope.
func (s *Session) HasPromptScope() bool {
	return s.HasScope(ipc.ScopePrompt) || s.HasScope(ipc.ScopePromptOperator)
}

func (s *Session) promptKindGranted(kind string) bool {
	scope, ok := ipc.PromptKindScope(kind)
	if !ok || !s.HasScope(scope) {
		return false
	}
	_, advertised := s.PromptKindVersion(kind)
	return advertised
}

// SendPrompt sends an agent -> renderer prompt message to one renderer
// session. show / update / close require the session to have advertised kind
// and to hold its scope, and the payload's kind, version and lease must agree
// with the routing; a prompt_show must pass ipc.ValidatePromptShow.
// prompt_branding_sync takes kind "" and needs any prompt scope.
// prompt_action_result is a reply on the action's envelope and is not sent
// through here.
func (b *Broker) SendPrompt(sessionKey, msgType, kind string, payload any) error {
	s := b.SessionByID(sessionKey)
	if s == nil {
		return ErrPromptSessionGone
	}
	switch msgType {
	case ipc.TypePromptBrandingSync:
		if kind != "" {
			return fmt.Errorf("%w: branding sync is not per kind", ErrPromptBadMessage)
		}
		if !s.HasPromptScope() {
			return ErrPromptScopeMissing
		}
	case ipc.TypePromptShow, ipc.TypePromptUpdate, ipc.TypePromptClose:
		if !s.promptKindGranted(kind) {
			return ErrPromptScopeMissing
		}
		if err := checkPromptPayload(s, sessionKey, msgType, kind, payload); err != nil {
			return err
		}
	default:
		return fmt.Errorf("%w: %s is not an agent -> renderer prompt type", ErrPromptBadMessage, msgType)
	}
	return s.SendNotify(newPromptEnvelopeID(msgType), msgType, payload)
}

func checkPromptPayload(s *Session, sessionKey, msgType, kind string, payload any) error {
	var lease ipc.PromptLease
	switch p := payload.(type) {
	case ipc.PromptShow:
		return checkPromptShowPayload(s, sessionKey, kind, p)
	case *ipc.PromptShow:
		if p == nil {
			return ErrPromptBadMessage
		}
		return checkPromptShowPayload(s, sessionKey, kind, *p)
	case ipc.PromptUpdate:
		lease = p.Lease
	case *ipc.PromptUpdate:
		if p == nil {
			return ErrPromptBadMessage
		}
		lease = p.Lease
	case ipc.PromptClose:
		lease = p.Lease
	case *ipc.PromptClose:
		if p == nil {
			return ErrPromptBadMessage
		}
		lease = p.Lease
	default:
		return fmt.Errorf("%w: %s payload %T", ErrPromptBadMessage, msgType, payload)
	}
	if lease.RendererSession != sessionKey {
		return fmt.Errorf("%w: lease names another renderer", ErrPromptBadMessage)
	}
	return nil
}

func checkPromptShowPayload(s *Session, sessionKey, kind string, p ipc.PromptShow) error {
	if p.Kind != kind {
		return fmt.Errorf("%w: payload kind %q != %q", ErrPromptBadMessage, p.Kind, kind)
	}
	if !s.promptKindHasVersion(kind, p.KindVersion) {
		return ErrPromptScopeMissing
	}
	if p.Lease.RendererSession != sessionKey {
		return fmt.Errorf("%w: lease names another renderer", ErrPromptBadMessage)
	}
	if err := ipc.ValidatePromptShow(p); err != nil {
		return fmt.Errorf("%w: %v", ErrPromptBadMessage, err)
	}
	return nil
}

func newPromptEnvelopeID(msgType string) string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand does not fail on supported platforms; an id collision
		// would only confuse correlation of a fire-and-forget message.
		return msgType
	}
	return msgType + "-" + hex.EncodeToString(buf[:])
}

// dispatchPromptMessage routes a renderer -> agent prompt message to the sink.
func (b *Broker) dispatchPromptMessage(s *Session, env *ipc.Envelope) {
	if !shouldForwardUnsolicitedHelperMessage(s, env) {
		log.Warn("dropping prompt message from a session without prompt scope",
			"type", env.Type, "sessionId", s.SessionID, "role", s.HelperRole)
		return
	}
	sink := b.loadPromptSink()
	if sink == nil {
		log.Warn("prompt message with no prompt host", "type", env.Type, "sessionId", s.SessionID)
		if env.Type == ipc.TypePromptAction {
			// Never leave a click unanswered: the renderer would sit on "Working…".
			var req ipc.PromptActionRequest
			_ = json.Unmarshal(env.Payload, &req)
			rev := req.Rev
			if rev == 0 {
				rev = 1
			}
			reply := ipc.PromptActionResult{PromptID: req.PromptID, ActionID: req.ActionID, Result: ipc.PromptActionRejectedStale, Rev: rev}
			if err := s.SendNotify(env.ID, ipc.TypePromptActionResult, reply); err != nil {
				log.Warn("failed to answer prompt action", "sessionId", s.SessionID, "error", err.Error())
			}
		}
		return
	}
	replyType, reply := sink.HandleRendererMessage(s, env.Type, env.Payload)
	if replyType == "" {
		return
	}
	if err := s.SendNotify(env.ID, replyType, reply); err != nil {
		log.Warn("failed to answer prompt message", "type", replyType, "sessionId", s.SessionID, "error", err.Error())
	}
}

// notifyPromptRendererConnected / Disconnected tell an observing sink about a
// prompt-capable session. Sessions without a prompt scope are never reported.
func (b *Broker) notifyPromptRendererConnected(s *Session) {
	if !s.HasPromptScope() {
		return
	}
	if obs, ok := b.loadPromptSink().(PromptSessionObserver); ok {
		obs.PromptRendererConnected(s)
	}
}

func (b *Broker) notifyPromptRendererDisconnected(s *Session) {
	if !s.HasPromptScope() {
		return
	}
	if obs, ok := b.loadPromptSink().(PromptSessionObserver); ok {
		obs.PromptRendererDisconnected(s)
	}
}
