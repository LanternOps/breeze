package sessionbroker

import (
	"github.com/breeze-rmm/agent/internal/ipc"
)

// macOS permission notice ownership (#10190 W04, plan Task 4.1 "TCC skew
// rule"). Untagged so CI on every OS checks it.
//
// Today the macOS helper shows its own permission reminder (a first-run
// dialog, then toasts). From W04 the agent may show it instead, as a
// notice.info prompt built from the helper's tcc_status. Exactly one of the
// two shows it:
//
//   - new agent + new helper, notice.info live: the agent sets
//     AuthResponse.AgentHandlesTCCNotice, the helper stays quiet, and the
//     agent builds the notice from that helper's reports;
//   - new agent + old helper (no prompt protocol): no flag, the helper
//     reminds as today, and the agent builds nothing for it;
//   - old agent + new helper: an old agent never sends the flag, so the
//     helper reminds as today;
//   - notice.info not live at the helper's authentication (the kill switch,
//     or before the first heartbeat): no flag, exactly today's behaviour.
//
// The flag is decided once, at authentication; a helper keeps it for the
// life of its connection. If notice.info is switched off later, the agent's
// notice takes its legacy path (the same reminder toast, sent by the agent).

// TCCNoticeHelper is what the TCC skew rule reads about a helper at its
// authentication.
type TCCNoticeHelper struct {
	GOOS           string
	Scopes         []string // granted scopes
	DesktopContext string
	PromptProtocol int // clamped prompt protocol (0 = predates the contract)
}

// AgentHandlesTCCNotice reports whether the agent shows the macOS permission
// notice for this helper. gateOpen is "this build speaks notice.info@1 and
// the server enables it". Only a helper whose status the agent reads (the
// desktop scope, sanitizeTCCStatusForSession) in a user session qualifies.
func AgentHandlesTCCNotice(h TCCNoticeHelper, gateOpen bool) bool {
	if !gateOpen || h.GOOS != "darwin" || h.PromptProtocol < 1 {
		return false
	}
	if h.DesktopContext == ipc.DesktopContextLoginWindow {
		return false
	}
	for _, s := range h.Scopes {
		if s == "desktop" {
			return true
		}
	}
	return false
}

// SetTCCNoticeGate installs the "notice.info is live" check the TCC skew rule
// reads at each helper authentication. Nil (the default) keeps every helper
// on its own reminder.
func (b *Broker) SetTCCNoticeGate(gate func() bool) {
	b.mu.Lock()
	b.tccNoticeGate = gate
	b.mu.Unlock()
}

// SetTCCStatusHandler installs the callback that receives the tcc_status of
// sessions the agent shows the permission notice for. It runs on its own
// goroutine, never on the session's receive loop.
func (b *Broker) SetTCCStatusHandler(fn func(s *Session, status ipc.TCCStatus)) {
	b.mu.Lock()
	b.tccStatusHandler = fn
	b.mu.Unlock()
}

// agentHandlesTCCNoticeFor applies the rule to an authenticating helper.
func (b *Broker) agentHandlesTCCNoticeFor(role ipc.HelperRole, authReq ipc.AuthRequest, scopes []string) bool {
	b.mu.RLock()
	gate, goos := b.tccNoticeGate, b.goos
	b.mu.RUnlock()
	if gate == nil {
		return false
	}
	h := TCCNoticeHelper{
		GOOS:           goos,
		Scopes:         scopes,
		DesktopContext: authReq.DesktopContext,
		PromptProtocol: promptGrantFromAuth(role, authReq).protocol,
	}
	// Cheap checks first: the gate reads the prompt host.
	if !AgentHandlesTCCNotice(h, true) {
		return false
	}
	return gate()
}

// forwardTCCStatus hands a sanitized status to the agent when it shows this
// session's permission notice.
func (b *Broker) forwardTCCStatus(s *Session, status ipc.TCCStatus) {
	if !s.AgentHandlesTCCNotice() {
		return
	}
	b.mu.RLock()
	fn := b.tccStatusHandler
	b.mu.RUnlock()
	if fn != nil {
		go fn(s, status)
	}
}

// AgentHandlesTCCNotice reports whether this session's auth response told
// the helper the agent shows its permission notice.
func (s *Session) AgentHandlesTCCNotice() bool { return s.agentHandlesTCCNotice.Load() }

// SetAgentHandlesTCCNoticeForTest sets the flag on a hand-built session.
func (s *Session) SetAgentHandlesTCCNoticeForTest(v bool) { s.agentHandlesTCCNotice.Store(v) }
