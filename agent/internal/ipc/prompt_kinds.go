package ipc

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// PromptCopyClass says whose words a kind may carry.
type PromptCopyClass string

const (
	// PromptCopyBreeze kinds carry Breeze-owned copy only, built by typed
	// constructors from catalog keys; never operator text.
	PromptCopyBreeze PromptCopyClass = "breeze"
	// PromptCopyOperator kinds may carry MSP copy verbatim in title, body
	// and operatorNote.
	PromptCopyOperator PromptCopyClass = "operator"
)

// promptKindClasses is the closed kind registry (spec §3.1). It must match
// packages/shared/src/promptHost/kinds.ts (pinned by
// TestPromptKindClassTableMatchesSharedRegistry). A kind not listed here is
// never granted a scope and never sent.
var promptKindClasses = map[string]PromptCopyClass{
	"notice.info":       PromptCopyBreeze,
	"restart.prompt":    PromptCopyOperator,
	"restart.final":     PromptCopyOperator,
	"remote.consent":    PromptCopyBreeze,
	"remote.session":    PromptCopyBreeze,
	"elevation.request": PromptCopyBreeze,
}

// PromptKindClass returns the copy class of a registered kind.
func PromptKindClass(kind string) (PromptCopyClass, bool) {
	c, ok := promptKindClasses[kind]
	return c, ok
}

// PromptKindScope returns the IPC scope a registered kind travels under.
func PromptKindScope(kind string) (string, bool) {
	switch c, ok := promptKindClasses[kind]; {
	case !ok:
		return "", false
	case c == PromptCopyOperator:
		return ScopePromptOperator, true
	default:
		return ScopePrompt, true
	}
}

// PromptKindNames returns the registered kinds, sorted.
func PromptKindNames() []string {
	out := make([]string, 0, len(promptKindClasses))
	for k := range promptKindClasses {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

var (
	promptKindAdPattern   = regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+@[1-9][0-9]{0,2}$`)
	promptKindNamePattern = regexp.MustCompile(`^[a-z]+(\.[a-z_]+)+$`)
	promptIDPattern       = regexp.MustCompile(`^[a-z][a-z_]*:[A-Za-z0-9._:-]+$`)
	promptActionIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	promptLocalePattern   = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)
	promptHex32Pattern    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	promptHex64Pattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// ParsePromptKindAd parses "<kind>@<n>" (n in 1..999, no leading zeros).
func ParsePromptKindAd(s string) (name string, version int, ok bool) {
	if !promptKindAdPattern.MatchString(s) {
		return "", 0, false
	}
	at := strings.LastIndexByte(s, '@')
	v, err := strconv.Atoi(s[at+1:])
	if err != nil || v < 1 {
		return "", 0, false
	}
	return s[:at], v, true
}

// IsPromptKindName reports whether s is shaped like a kind name.
func IsPromptKindName(s string) bool { return promptKindNamePattern.MatchString(s) }

// IsPromptDecision: a prompt is a decision while it waits on the person at
// the keyboard and is not a session indicator. A decision has exactly one
// safe action and defaultActionId names it; Esc / the close box map to it.
func IsPromptDecision(state PromptState, presentation PromptPresentation) bool {
	return state == PromptStatePending && presentation != PromptPresentationIndicator
}

// MaxPromptActions is the most actions one state may carry.
const MaxPromptActions = 3

func checkLen(field, v string, min, max int) error {
	n := utf8.RuneCountInString(v)
	if n < min || n > max {
		return fmt.Errorf("%s length %d outside %d..%d code points", field, n, min, max)
	}
	return nil
}

func validatePromptLease(l PromptLease) error {
	if err := checkLen("lease.rendererSession", l.RendererSession, 1, 200); err != nil {
		return err
	}
	if l.Epoch < 1 {
		return errors.New("lease.epoch must be >= 1")
	}
	return nil
}

func validatePromptCopy(c PromptCopy) error {
	if err := checkLen("copy.title", c.Title, 1, 200); err != nil {
		return err
	}
	for _, f := range []struct {
		name string
		v    string
		max  int
	}{{"copy.body", c.Body, 2000}, {"copy.consequence", c.Consequence, 500}, {"copy.operatorNote", c.OperatorNote, 1000}, {"copy.stateDetail", c.StateDetail, 500}} {
		if err := checkLen(f.name, f.v, 0, f.max); err != nil {
			return err
		}
	}
	return nil
}

func validatePromptActions(actions []PromptAction, defaultID string) error {
	if len(actions) > MaxPromptActions {
		return fmt.Errorf("at most %d actions per state, got %d", MaxPromptActions, len(actions))
	}
	seen := make(map[string]struct{}, len(actions))
	for _, a := range actions {
		if !promptActionIDPattern.MatchString(a.ID) {
			return fmt.Errorf("action id %q is malformed", a.ID)
		}
		if err := checkLen("action label", a.Label, 1, 80); err != nil {
			return err
		}
		switch a.Role {
		case PromptRoleSafe, PromptRoleProceed, PromptRoleNeutral:
		default:
			return fmt.Errorf("action %q has unknown role %q", a.ID, a.Role)
		}
		if _, dup := seen[a.ID]; dup {
			return fmt.Errorf("duplicate action id %s", a.ID)
		}
		seen[a.ID] = struct{}{}
	}
	if defaultID != "" {
		if _, ok := seen[defaultID]; !ok {
			return errors.New("defaultActionId names no action")
		}
	}
	return nil
}

func validatePromptTiming(t PromptTiming, actions []PromptAction) error {
	if t.PresentWithinMs < 1 || t.PresentWithinMs > 60_000 {
		return fmt.Errorf("timing.presentWithinMs %d outside 1..60000", t.PresentWithinMs)
	}
	if t.DeadlineUnixMs < 0 || t.ResponseMs < 0 || t.ResponseMs > 24*60*60*1000 {
		return errors.New("timing budget out of range")
	}
	if t.DeadlineUnixMs != 0 && t.ResponseMs != 0 {
		return errors.New("deadlineUnixMs and responseMs are exclusive")
	}
	if t.Expiry != nil {
		if err := checkLen("timing.expiry.text", t.Expiry.Text, 0, 500); err != nil {
			return err
		}
		if t.Expiry.ActionID != nil {
			found := false
			for _, a := range actions {
				if a.ID == *t.Expiry.ActionID {
					found = true
					break
				}
			}
			if !found {
				return errors.New("expiry names no action")
			}
		}
	}
	return nil
}

// ValidatePromptShow enforces the contract invariants on a prompt_show
// before it is sent or drawn (mirrors promptShowSchema in
// packages/shared/src/promptHost/schema.ts). A renderer handed a show that
// fails it answers prompt_closed{render_failed}.
func ValidatePromptShow(p PromptShow) error {
	if err := checkLen("promptId", p.PromptID, 1, 200); err != nil {
		return err
	}
	if !promptIDPattern.MatchString(p.PromptID) {
		return fmt.Errorf("promptId %q must be <domain>:<id>", p.PromptID)
	}
	if p.Rev < 1 {
		return errors.New("rev must be >= 1")
	}
	if err := validatePromptLease(p.Lease); err != nil {
		return err
	}
	if len(p.Kind) > 64 || !promptKindNamePattern.MatchString(p.Kind) {
		return fmt.Errorf("kind %q is malformed", p.Kind)
	}
	if p.KindVersion < 1 || p.KindVersion > 999 {
		return fmt.Errorf("kindVersion %d outside 1..999", p.KindVersion)
	}
	if !p.State.valid() {
		return fmt.Errorf("unknown state %q", p.State)
	}
	if !p.Presentation.valid() {
		return fmt.Errorf("unknown presentation %q", p.Presentation)
	}
	if err := validatePromptCopy(p.Copy); err != nil {
		return err
	}
	if len(p.Facts) > 8 {
		return errors.New("at most 8 facts")
	}
	for _, f := range p.Facts {
		if err := checkLen("fact label", f.Label, 1, 60); err != nil {
			return err
		}
		if err := checkLen("fact value", f.Value, 0, 4000); err != nil {
			return err
		}
	}
	if err := validatePromptActions(p.Actions, p.DefaultActionID); err != nil {
		return err
	}
	if IsPromptDecision(p.State, p.Presentation) {
		safe := ""
		count := 0
		for _, a := range p.Actions {
			if a.Role == PromptRoleSafe {
				safe = a.ID
				count++
			}
		}
		if count != 1 {
			return errors.New("a decision carries exactly one safe action")
		}
		if p.DefaultActionID != safe {
			return errors.New("a decision defaults to its safe action")
		}
	}
	if err := validatePromptTiming(p.Timing, p.Actions); err != nil {
		return err
	}
	if p.Focus != PromptFocusSteal && p.Focus != PromptFocusNoActivate {
		return fmt.Errorf("unknown focus %q", p.Focus)
	}
	if p.ListEntry.ExpiresAtUnixMs < 0 {
		return errors.New("listEntry.expiresAtUnixMs out of range")
	}
	if len(p.Locale) > 35 || !promptLocalePattern.MatchString(p.Locale) {
		return fmt.Errorf("locale %q is malformed", p.Locale)
	}
	if p.Direction != "ltr" && p.Direction != "rtl" {
		return fmt.Errorf("unknown direction %q", p.Direction)
	}
	if ref := p.IdentityRef; ref != nil {
		if !promptHex32Pattern.MatchString(ref.ScopeID) || (ref.LogoSha256 != "" && !promptHex64Pattern.MatchString(ref.LogoSha256)) {
			return errors.New("identityRef is malformed")
		}
	}
	// Unknown kinds fail closed as breeze-class.
	if class, ok := PromptKindClass(p.Kind); (!ok || class == PromptCopyBreeze) && p.Copy.OperatorNote != "" {
		return errors.New("operator text on a breeze-class kind")
	}
	return nil
}

// ApplyPromptUpdate merges a prompt_update into the current show the way
// every renderer must, and validates the merged state (mirrors
// applyPromptUpdate in the shared schema).
func ApplyPromptUpdate(show PromptShow, u PromptUpdate) (PromptShow, error) {
	if u.PromptID != show.PromptID {
		return show, errors.New("update is for another prompt")
	}
	if u.Rev <= show.Rev {
		return show, errors.New("rev is not newer")
	}
	merged := show
	merged.Rev = u.Rev
	merged.Lease = u.Lease
	if u.State != nil {
		merged.State = *u.State
	}
	if u.Copy != nil {
		merged.Copy = *u.Copy
	}
	if u.Facts != nil {
		merged.Facts = append([]PromptFact(nil), (*u.Facts)...)
	}
	if u.Timing != nil {
		merged.Timing = *u.Timing
	}
	if u.Actions != nil {
		merged.Actions = append([]PromptAction{}, (*u.Actions)...)
		merged.DefaultActionID = u.DefaultActionID
	} else if u.DefaultActionID != "" {
		return show, errors.New("defaultActionId travels with actions")
	}
	if err := ValidatePromptShow(merged); err != nil {
		return show, err
	}
	return merged, nil
}
