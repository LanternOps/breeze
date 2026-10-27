package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptidentity"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// notice.info call sites (#10190 W04, plan Task 4.1).
//
// The safe-mode reboot warning, the remote-session-ended notice and the
// macOS permission notice go through the prompt host only when all three
// switches are on for a session (compatibility order step 2): this build
// constructs notice.info (promptkinds.Register), the session's renderer
// advertised notice.info@1 at its live authentication, and the server lists
// it in promptHost.enabledKinds. When no session qualifies, the call site
// makes exactly today's call; when some do, the host draws the card there
// and sends the others today's toast, one session at a time.

// openSettingsTimeout bounds the open_settings action (it runs while the
// host serialises decisions).
const openSettingsTimeout = 15 * time.Second

// tccNoticeState remembers the permission notice open per macOS user, so a
// change in the missing set replaces it and a grant withdraws it.
type tccNoticeState struct {
	mu  sync.Mutex
	ids map[string]string // owner key -> prompt id
}

func (s *tccNoticeState) swap(owner, id string) (prev string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ids == nil {
		s.ids = map[string]string{}
	}
	prev = s.ids[owner]
	if id == "" {
		delete(s.ids, owner)
	} else {
		s.ids[owner] = id
	}
	return prev
}

// notices builds notice.info prompts whose legacy calls go through this
// heartbeat's broker.
func (h *Heartbeat) notices() promptkinds.Notices {
	return promptkinds.Notices{Notify: h.notifyOwner, OpenSettings: h.openMacSettings}
}

// noticeOwner is the prompt-host owner a helper session draws for.
func noticeOwner(s *sessionbroker.Session) prompthost.Owner {
	return prompthost.RendererFromSession(s, messageOwnerGOOS).Owner
}

// noticeOwnersOf returns one owner per session (deduplicated by owner key).
func noticeOwnersOf(sessions []*sessionbroker.Session) []prompthost.Owner {
	seen := map[string]bool{}
	var out []prompthost.Owner
	for _, s := range sessions {
		o := noticeOwner(s)
		if seen[o.Key()] {
			continue
		}
		seen[o.Key()] = true
		out = append(out, o)
	}
	return out
}

// notifyOwner sends a legacy notify toast to the notify target serving o
// (the per-session half of a notice whose other sessions took the card).
func (h *Heartbeat) notifyOwner(o prompthost.Owner, req ipc.NotifyRequest) error {
	if h.sessionBroker == nil {
		return errors.New("no session broker")
	}
	for _, s := range h.sessionBroker.NotifyTargetsExcept("") {
		if noticeOwner(s).Key() == o.Key() {
			return s.SendNotify("notice-legacy-"+randomNotifyID(), ipc.TypeNotify, req)
		}
	}
	return fmt.Errorf("no notify-capable helper for %s", o.Key())
}

// openMacSettingsCmd opens a System Settings URL in a macOS user's GUI
// session from the root agent: launchctl asuser joins the user's bootstrap
// namespace and sudo -u runs open as that user, so LaunchServices opens the
// pane on their desktop. A var so tests never run it.
var openMacSettingsCmd = func(ctx context.Context, uid int, url string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("opening System Settings is supported only on macOS")
	}
	u := strconv.Itoa(uid)
	out, err := exec.CommandContext(ctx, "/bin/launchctl", "asuser", u, "/usr/bin/sudo", "-u", "#"+u, "/usr/bin/open", url).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, truncateForLog(string(out), 200))
	}
	return nil
}

// openMacSettings is the permission notice's open_settings action. The pane
// comes from a fixed allowlist (promptkinds.SettingsURL), never from a
// renderer.
func (h *Heartbeat) openMacSettings(o prompthost.Owner, permission string) error {
	if o.UID <= 0 {
		return errors.New("the notice has no macOS user to open System Settings for")
	}
	url, err := promptkinds.SettingsURL(permission)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), openSettingsTimeout)
	defer cancel()
	return openMacSettingsCmd(ctx, o.UID, url)
}

func truncateForLog(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// stampIdentity pins the MSP identity in force on a prompt (identityRef):
// its list entries carry the scope, and a later scope change closes it.
func stampIdentity(p *prompthost.Prompt, id promptidentity.Identity, ok bool) {
	if !ok || id.ScopeID == "" {
		return
	}
	ref := &ipc.PromptIdentityRef{ScopeID: id.ScopeID}
	if id.Logo != nil {
		ref.LogoSha256 = id.Logo.Sha256
	}
	p.Show.IdentityRef = ref
}

// showNotice routes a notice: when no owner can take the prompt path it
// makes exactly today's call (legacyAll); otherwise the host shows it, and
// the host's per-owner Legacy covers the owners that cannot.
func (h *Heartbeat) showNotice(p prompthost.Prompt, owners []prompthost.Owner, legacyAll func()) {
	host := h.promptHost
	if host == nil || len(owners) == 0 {
		legacyAll()
		return
	}
	any := false
	for _, o := range owners {
		if host.PromptPathAvailable(p.Kind.Name, p.Kind.Version, o) {
			any = true
			break
		}
	}
	if !any {
		legacyAll()
		return
	}
	p.Owners = owners
	// Stamp and show with no scope change in progress: a notice shown while
	// a change is taking down the old scope's prompts would otherwise be
	// created under that scope after its purge.
	var err error
	if h.promptIdentity != nil {
		h.promptIdentity.WithSettledIdentity(func(id promptidentity.Identity, ok bool) {
			stampIdentity(&p, id, ok)
			err = host.Show(p)
		})
	} else {
		err = host.Show(p)
	}
	if err != nil {
		if errors.Is(err, prompthost.ErrTombstoned) {
			// Acknowledged (or, for a one-off notice, closed) within the
			// last 24 h: the person has seen it, and it stays in the list.
			log.Info("notice not shown again: it was acknowledged or closed within the last 24 hours", "promptId", p.ID)
			return
		}
		log.Warn("notice not shown through the prompt host; sending today's notice", "promptId", p.ID, "error", err.Error())
		legacyAll()
	}
}

// notifySafeModeReboot warns every signed-in session of a safe-mode reboot
// delayMinutes from now (already parsed and clamped by
// tools.ShutdownDelayMinutes). Legacy: today's broadcast.
func (h *Heartbeat) notifySafeModeReboot(delayMinutes int) {
	if h.sessionBroker == nil {
		return
	}
	legacy := func() {
		h.sessionBroker.BroadcastNotification("Safe Mode Reboot", safeModeRebootNotice(delayMinutes), "critical")
	}
	delay := time.Duration(delayMinutes) * time.Minute
	p := h.notices().SafeModeRebootNotice(delay, time.Now().Add(delay))
	h.showNotice(p, noticeOwnersOf(h.sessionBroker.NotifyTargetsExcept("")), legacy)
}

// notifySessionEnded tells the person in targetWinSession that a remote
// session ended. Legacy: today's "Remote session ended" notice.
func (h *Heartbeat) notifySessionEnded(sessionID string, prompt *ipc.DesktopPrompt, startedAt time.Time, targetWinSession string) {
	legacy := func() { h.sendSessionNotify("Remote session ended", targetWinSession) }
	if h.sessionBroker == nil {
		return
	}
	target := h.sessionNoticeTarget(targetWinSession)
	if target == nil {
		legacy() // logs that no helper can show it, as today
		return
	}
	var d time.Duration
	if !startedAt.IsZero() {
		d = time.Since(startedAt)
	}
	p := h.notices().RemoteSessionEndedNotice(sessionID, d, derefString(prompt.TechnicianName))
	h.showNotice(p, []prompthost.Owner{noticeOwner(target)}, legacy)
}

// tccNoticeLive is the TCC skew rule's gate: this build speaks
// notice.info@1 and the server enables it.
func (h *Heartbeat) tccNoticeLive() bool {
	host := h.promptHost
	return host != nil && host.KindLive(promptkinds.NoticeInfo.Name, promptkinds.NoticeInfo.Version)
}

// tccMissingPermissions mirrors the helper's missingPermissions.
func tccMissingPermissions(st ipc.TCCStatus) []string {
	var missing []string
	if !st.ScreenRecording {
		missing = append(missing, promptkinds.PermissionScreenRecording)
	}
	if !st.Accessibility {
		missing = append(missing, promptkinds.PermissionAccessibility)
	}
	if !st.FullDiskAccess {
		missing = append(missing, promptkinds.PermissionFullDiskAccess)
	}
	return missing
}

// handleTCCNotice builds the macOS permission notice from a helper's
// tcc_status — only for a session the agent told, at its authentication,
// that it shows the notice (sessionbroker.AgentHandlesTCCNotice); every
// other helper reminds by itself. Like the helper's own guidance it asks
// only while Full Disk Access is missing (macOS prompts for the others).
// An open notice is not re-sent; a new missing set replaces it; a grant
// withdraws it.
func (h *Heartbeat) handleTCCNotice(s *sessionbroker.Session, st ipc.TCCStatus) {
	if s == nil || !s.AgentHandlesTCCNotice() {
		return
	}
	owner := noticeOwner(s)
	host := h.promptHost
	if st.FullDiskAccess {
		if prev := h.tccNotices.swap(owner.Key(), ""); prev != "" && host != nil {
			if err := host.Close(prev, ipc.PromptCloseWithdrawn); err != nil && !errors.Is(err, prompthost.ErrUnknownPrompt) {
				log.Warn("permission notice not withdrawn", "promptId", prev, "error", err.Error())
			}
		}
		return
	}
	missing := tccMissingPermissions(st)
	p := h.notices().MacPermissionNotice(missing)
	if host != nil && host.IsOpen(p.ID) {
		return // still on screen or in the list: not re-sent every report
	}
	if prev := h.tccNotices.swap(owner.Key(), p.ID); prev != "" && prev != p.ID && host != nil {
		if err := host.Close(prev, ipc.PromptCloseSuperseded); err != nil && !errors.Is(err, prompthost.ErrUnknownPrompt) {
			log.Warn("superseded permission notice not closed", "promptId", prev, "error", err.Error())
		}
	}
	reminder := promptkinds.LegacyMacPermissionReminder(missing)
	legacy := func() {
		if err := s.SendNotify("tcc-reminder-"+randomNotifyID(), ipc.TypeNotify, reminder); err != nil {
			log.Warn("permission reminder not sent", "sessionId", s.SessionID, "error", err.Error())
		}
	}
	h.showNotice(p, []prompthost.Owner{owner}, legacy)
}
