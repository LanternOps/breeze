package promptkinds

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// notice.info constructors (#10190 W04, plan Task 4.1).
//
// Three notices move onto the prompt host: the safe-mode reboot warning, the
// macOS permission reminder and the remote-session-ended notice. Each one's
// Legacy is the call the agent (or, for permissions, the helper) makes today,
// unchanged, so a session whose renderer does not draw notice.info — or a
// server that has not enabled it — sees exactly what it saw before.
//
// Copy comes from the catalog's notice namespace and is rendered per session
// locale by the host (Prompt.Localize); Show carries the en rendering.

const (
	actionOK           = "ok"
	actionOpenSettings = "open_settings"

	noticeNamespace       = "notice"
	noticePresentWithinMs = 10_000

	// maxTechnicianRunes caps the technician name a session-ended notice
	// names (the identity-name cap).
	maxTechnicianRunes = 120
	// maxSessionIDBytes bounds the session id inside a prompt id.
	maxSessionIDBytes = 128
)

// macOS permission names, as the helper reports them (userhelper
// missingPermissions) and as systemSettingsURLForPermission knows them.
const (
	PermissionFullDiskAccess  = "Full Disk Access"
	PermissionScreenRecording = "Screen Recording"
	PermissionAccessibility   = "Accessibility"
)

// permissionKeys maps a known permission to its catalog key, in the order
// the notice lists them (Full Disk Access first: macOS has no prompt for it).
var permissionKeys = []struct{ name, key string }{
	{PermissionFullDiskAccess, "tcc.permission.fullDiskAccess"},
	{PermissionScreenRecording, "tcc.permission.screenRecording"},
	{PermissionAccessibility, "tcc.permission.accessibility"},
}

// Notices builds notice.info prompts. The caller sets each prompt's Owners
// (and IdentityRef) before handing it to the host.
type Notices struct {
	// Notify sends a legacy notify toast to one owner's session (today's
	// call). Required.
	Notify func(o prompthost.Owner, req ipc.NotifyRequest) error
	// OpenSettings opens the System Settings pane for a permission in the
	// owner's GUI session (macOS). Required for MacPermissionNotice's
	// open_settings action; a nil func refuses the action.
	OpenSettings func(o prompthost.Owner, permission string) error
}

var errNoticeAction = errors.New("promptkinds: action not offered by this notice")

// SafeModeRebootNotice warns that the computer restarts into safe mode with
// networking after delay, at the moment at. Its id is
// notice:safe_mode:<unixMs of at>.
func (n Notices) SafeModeRebootNotice(delay time.Duration, at time.Time) prompthost.Prompt {
	timeToken := fmt.Sprintf("{time:%d}", at.UnixMilli())
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, noticeNamespace, "safeMode.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		var body string
		if delay <= 0 {
			body, err = promptcatalog.Render(loc, noticeNamespace, "safeMode.bodyNow", nil)
		} else {
			// {time:<unixMs>} is renderer-owned: each renderer shows the
			// moment in the person's own clock format.
			body, err = promptcatalog.Render(loc, noticeNamespace, "safeMode.body", map[string]string{"at": timeToken})
		}
		if err != nil {
			return prompthost.Localized{}, err
		}
		return n.okOnly(loc, ipc.PromptCopy{Title: title, Body: body}, nil)
	}
	legacy := LegacySafeModeReboot(delay)
	return n.build(fmt.Sprintf("notice:safe_mode:%d", at.UnixMilli()), okActions(), localize,
		func(o prompthost.Owner) error { return n.notify(o, legacy) },
		acknowledgeOnly)
}

// MacPermissionNotice tells the person which macOS permissions the Breeze
// agent still needs, with an Open Settings action. Its id is
// notice:tcc:<first 8 hex of sha256 of the sorted, deduplicated set>.
// Names other than the three known permissions are ignored.
func (n Notices) MacPermissionNotice(missing []string) prompthost.Prompt {
	known := knownPermissions(missing)
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, noticeNamespace, "tcc.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		bodyKey := "tcc.bodyOthers"
		if len(known) > 0 && known[0].name == PermissionFullDiskAccess {
			bodyKey = "tcc.bodyFullDiskAccess"
		}
		body, err := promptcatalog.Render(loc, noticeNamespace, bodyKey, nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		var facts []ipc.PromptFact
		if len(known) > 0 {
			label, err := promptcatalog.Render(loc, noticeNamespace, "tcc.missingLabel", nil)
			if err != nil {
				return prompthost.Localized{}, err
			}
			names := make([]string, 0, len(known))
			for _, p := range known {
				name, err := promptcatalog.Render(loc, noticeNamespace, p.key, nil)
				if err != nil {
					return prompthost.Localized{}, err
				}
				names = append(names, name)
			}
			facts = []ipc.PromptFact{{Label: label, Value: strings.Join(names, ", ")}}
		}
		l, err := n.okOnly(loc, ipc.PromptCopy{Title: title, Body: body}, facts)
		if err != nil {
			return l, err
		}
		open, err := promptcatalog.Render(loc, noticeNamespace, "action.openSettings", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		l.ActionLabels[actionOpenSettings] = open
		return l, nil
	}
	names := make([]string, 0, len(known))
	for _, p := range known {
		names = append(names, p.name)
	}
	legacy := LegacyMacPermissionReminder(names)
	actions := append(okActions(), ipc.PromptAction{ID: actionOpenSettings, Label: actionOpenSettings, Role: ipc.PromptRoleNeutral})
	onAction := func(actionID string, from prompthost.Owner) (prompthost.ActionOutcome, error) {
		if actionID != actionOpenSettings {
			return acknowledgeOnly(actionID, from)
		}
		if n.OpenSettings == nil || len(names) == 0 {
			return prompthost.ActionOutcome{}, errors.New("promptkinds: no settings pane to open")
		}
		// Full Disk Access first: it is the one macOS cannot prompt for.
		if err := n.OpenSettings(from, names[0]); err != nil {
			return prompthost.ActionOutcome{}, fmt.Errorf("open System Settings: %w", err)
		}
		return prompthost.ActionOutcome{Accepted: true}, nil
	}
	return n.build("notice:tcc:"+permissionSetID(names), actions, localize,
		func(o prompthost.Owner) error { return n.notify(o, legacy) },
		onAction)
}

// RemoteSessionEndedNotice tells the person a technician's remote session
// ended, and how long it lasted (d <= 0: unknown, not stated). Its id is
// notice:session_ended:<sessionID>.
func (n Notices) RemoteSessionEndedNotice(sessionID string, d time.Duration, technician string) prompthost.Prompt {
	tech := capRunes(promptcatalog.SanitizeIdentityName(technician), maxTechnicianRunes)
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, noticeNamespace, "sessionEnded.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		var body string
		if tech != "" {
			body, err = promptcatalog.Render(loc, noticeNamespace, "sessionEnded.body", map[string]string{"technician": tech})
		} else {
			body, err = promptcatalog.Render(loc, noticeNamespace, "sessionEnded.bodyNoTechnician", nil)
		}
		if err != nil {
			return prompthost.Localized{}, err
		}
		var facts []ipc.PromptFact
		if d > 0 {
			label, err := promptcatalog.Render(loc, noticeNamespace, "sessionEnded.durationLabel", nil)
			if err != nil {
				return prompthost.Localized{}, err
			}
			var value string
			if minutes := int(d / time.Minute); minutes < 1 {
				value, err = promptcatalog.Render(loc, noticeNamespace, "sessionEnded.durationUnderMinute", nil)
			} else {
				value, err = promptcatalog.Render(loc, noticeNamespace, "sessionEnded.durationMinutes", map[string]string{"minutes": strconv.Itoa(minutes)})
			}
			if err != nil {
				return prompthost.Localized{}, err
			}
			facts = []ipc.PromptFact{{Label: label, Value: value}}
		}
		return n.okOnly(loc, ipc.PromptCopy{Title: title, Body: body}, facts)
	}
	legacy := LegacyRemoteSessionEnded()
	return n.build("notice:session_ended:"+promptIDPart(sessionID), okActions(), localize,
		func(o prompthost.Owner) error { return n.notify(o, legacy) },
		acknowledgeOnly)
}

// LegacySafeModeReboot is today's safe-mode toast, broadcast to every
// session by handleRebootSafeMode (issue #3373 wording).
func LegacySafeModeReboot(delay time.Duration) ipc.NotifyRequest {
	return ipc.NotifyRequest{Title: "Safe Mode Reboot", Body: LegacySafeModeRebootBody(int(delay / time.Minute)), Urgency: "critical"}
}

// LegacySafeModeRebootBody renders the safe-mode toast body for a delay in
// minutes that tools.ShutdownDelayMinutes already parsed and clamped.
func LegacySafeModeRebootBody(delayMinutes int) string {
	if delayMinutes <= 0 {
		return "System is rebooting into Safe Mode with Networking. Please save all work."
	}
	unit := "minutes"
	if delayMinutes == 1 {
		unit = "minute"
	}
	return fmt.Sprintf("System will reboot into Safe Mode with Networking in %d %s. Please save all work.", delayMinutes, unit)
}

// LegacyRemoteSessionEnded is today's remote-session-ended notice
// (heartbeat sessionNoticeRequest: a toast with a fallback dialog).
func LegacyRemoteSessionEnded() ipc.NotifyRequest {
	return ipc.NotifyRequest{Title: "Breeze Agent", Body: "Remote session ended", Urgency: "normal", FallbackDialog: true}
}

// LegacyMacPermissionReminder is the reminder toast the macOS helper shows
// itself today (userhelper showTCCNotification). The agent sends it only for
// a helper it told to stay quiet (AuthResponse.AgentHandlesTCCNotice) when
// notice.info cannot be drawn.
func LegacyMacPermissionReminder(missing []string) ipc.NotifyRequest {
	body := "Screen Recording and Accessibility still need approval. If the macOS prompts were dismissed, grant them in System Settings > Privacy & Security."
	for _, m := range missing {
		if m == PermissionFullDiskAccess {
			body = "Full Disk Access is required. Grant it in System Settings > Privacy & Security > Full Disk Access. macOS will prompt separately for Screen Recording and Accessibility."
			break
		}
	}
	return ipc.NotifyRequest{Title: "Breeze: Permission Required", Body: body}
}

// SettingsURL is the System Settings pane for a known permission (the same
// allowlist as userhelper systemSettingsURLForPermission).
func SettingsURL(permission string) (string, error) {
	switch permission {
	case PermissionScreenRecording:
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture", nil
	case PermissionAccessibility:
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", nil
	case PermissionFullDiskAccess:
		return "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles", nil
	}
	return "", fmt.Errorf("unknown permission %q", permission)
}

func (n Notices) notify(o prompthost.Owner, req ipc.NotifyRequest) error {
	if n.Notify == nil {
		return errors.New("promptkinds: no legacy notifier")
	}
	return n.Notify(o, req)
}

// okOnly finishes a Localized with the ok label.
func (n Notices) okOnly(loc promptcatalog.Locale, c ipc.PromptCopy, facts []ipc.PromptFact) (prompthost.Localized, error) {
	ok, err := promptcatalog.Render(loc, noticeNamespace, "action.ok", nil)
	if err != nil {
		return prompthost.Localized{}, err
	}
	return prompthost.Localized{Copy: c, Facts: facts, ActionLabels: map[string]string{actionOK: ok}}, nil
}

func okActions() []ipc.PromptAction {
	return []ipc.PromptAction{{ID: actionOK, Label: actionOK, Role: ipc.PromptRoleSafe}}
}

// acknowledgeOnly is the action handler of a notice whose only action is ok:
// accepted, and closed resolved after the kind's transition to approved, so
// the card goes away and the list keeps the entry as an outcome.
func acknowledgeOnly(actionID string, _ prompthost.Owner) (prompthost.ActionOutcome, error) {
	if actionID != actionOK {
		return prompthost.ActionOutcome{}, errNoticeAction
	}
	resolved := ipc.PromptCloseResolved
	return prompthost.ActionOutcome{Accepted: true, Close: &resolved}, nil
}

// build assembles a notice with its en content in Show.
func (n Notices) build(id string, actions []ipc.PromptAction, localize func(promptcatalog.Locale) (prompthost.Localized, error), legacy func(prompthost.Owner) error, onAction func(string, prompthost.Owner) (prompthost.ActionOutcome, error)) prompthost.Prompt {
	show := ipc.PromptShow{
		PromptID:        id,
		Kind:            NoticeInfo.Name,
		KindVersion:     NoticeInfo.Version,
		State:           ipc.PromptStatePending,
		Presentation:    ipc.PromptPresentationCard,
		Actions:         actions,
		DefaultActionID: actionOK,
		Timing:          ipc.PromptTiming{PresentWithinMs: noticePresentWithinMs},
		Focus:           ipc.PromptFocusNoActivate,
		ListEntry:       ipc.PromptListEntry{Persistent: true},
		Locale:          string(promptcatalog.LocaleEN),
		Direction:       "ltr",
	}
	if l, err := localize(promptcatalog.LocaleEN); err == nil {
		show.Copy, show.Facts = l.Copy, l.Facts
		for i := range show.Actions {
			if label, ok := l.ActionLabels[show.Actions[i].ID]; ok {
				show.Actions[i].Label = label
			}
		}
	}
	// An en render failure leaves an empty title, which the host's
	// validation refuses at Show: the caller then takes its legacy call.
	return prompthost.Prompt{
		ID:       id,
		Kind:     NoticeInfo,
		Show:     show,
		Legacy:   legacy,
		OnAction: onAction,
		Localize: localize,
	}
}

func knownPermissions(missing []string) []struct{ name, key string } {
	have := map[string]bool{}
	for _, m := range missing {
		have[m] = true
	}
	var out []struct{ name, key string }
	for _, p := range permissionKeys {
		if have[p.name] {
			out = append(out, p)
		}
	}
	return out
}

// permissionSetID is the first 8 hex characters of sha256 over the sorted
// permission names, newline-joined.
func permissionSetID(names []string) string {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return hex.EncodeToString(sum[:])[:8]
}

// promptIDPart keeps a server-supplied id usable inside a prompt id
// ([A-Za-z0-9._:-]+): an id already in that alphabet and short enough is
// kept; anything else is replaced by its sha8, so it is still stable.
func promptIDPart(id string) string {
	ok := id != "" && len(id) <= maxSessionIDBytes
	for _, r := range id {
		if !promptIDRune(r) {
			ok = false
			break
		}
	}
	if ok {
		return id
	}
	sum := sha256.Sum256([]byte(id))
	return "h" + hex.EncodeToString(sum[:])[:8]
}

// promptIDRune reports whether r is in a prompt id's alphabet after the
// domain ([A-Za-z0-9._:-]).
func promptIDRune(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return r == '.' || r == '_' || r == ':' || r == '-'
}

func capRunes(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:max]))
}
