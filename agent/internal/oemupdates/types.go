package oemupdates

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// The wire types here mirror packages/shared/src/validators/oemUpdates.ts. The
// zod schemas are the contract; these types must accept exactly what they accept
// and produce only what they accept. TestResultRoundTripsSharedFixture holds the
// two together.

// Lanes.
const (
	LaneDell    = "dell"
	LaneSurface = "surface"
	LaneHP      = "hp"
	LaneLenovo  = "lenovo"
)

// Categories.
const (
	CategoryBIOS        = "bios"
	CategoryFirmware    = "firmware"
	CategoryDriver      = "driver"
	CategoryApplication = "application"
)

// Outcome is the normalized result of one run.
type Outcome string

// The 12 outcomes (OEM_OUTCOMES).
const (
	OutcomeSuccess               Outcome = "success"
	OutcomeSuccessRebootRequired Outcome = "success_reboot_required"
	OutcomeNoUpdates             Outcome = "no_updates"
	OutcomePartial               Outcome = "partial"
	OutcomeFailed                Outcome = "failed"
	OutcomeNotSupported          Outcome = "not_supported"
	OutcomeToolUnavailable       Outcome = "tool_unavailable"
	OutcomeBlockedOnBattery      Outcome = "blocked_on_battery"
	OutcomeBlockedRebootPending  Outcome = "blocked_reboot_pending"
	OutcomeBlockedNoRecoveryKey  Outcome = "blocked_no_recovery_key"
	OutcomeRetryLater            Outcome = "retry_later"
	OutcomeInterrupted           Outcome = "interrupted"
)

// Item results.
const (
	ItemInstalled = "installed"
	ItemFailed    = "failed"
	ItemSkipped   = "skipped"
)

// Skip reasons.
const (
	SkipGate            = "gate"
	SkipNoRebootControl = "no_reboot_control"
	SkipNoRecoveryKey   = "no_recovery_key"
	SkipPower           = "power"
)

// Takeover values. W02 never takes over a vendor schedule (W06 adds it).
const (
	TakeoverOK           = "ok"
	TakeoverPolicyLocked = "policy_locked"
	TakeoverNotAttempted = "not_attempted"
)

// Triggers.
const (
	TriggerScheduled = "scheduled"
	TriggerOnDemand  = "on_demand"
)

// Contract bounds.
const (
	maxItems            = 200
	maxItemTitle        = 200
	maxVersionLen       = 64
	maxBlockedIDs       = 200
	maxBlockedIDLen     = 128
	maxProtectorIDs     = 16
	maxPrerequisites    = 8
	maxPrereqNameLen    = 64
	maxOccurrenceKeyLen = 64
	maxURLLen           = 2048
	maxErrorCodeLen     = 64
	maxPayloadBytes     = 64 << 10
)

var (
	allLanes      = []string{LaneDell, LaneSurface, LaneHP, LaneLenovo}
	allCategories = []string{CategoryBIOS, CategoryFirmware, CategoryDriver, CategoryApplication}
	allOutcomes   = []Outcome{
		OutcomeSuccess, OutcomeSuccessRebootRequired, OutcomeNoUpdates, OutcomePartial, OutcomeFailed,
		OutcomeNotSupported, OutcomeToolUnavailable, OutcomeBlockedOnBattery, OutcomeBlockedRebootPending,
		OutcomeBlockedNoRecoveryKey, OutcomeRetryLater, OutcomeInterrupted,
	}
	itemResults  = []string{ItemInstalled, ItemFailed, ItemSkipped}
	skipReasons  = []string{SkipGate, SkipNoRebootControl, SkipNoRecoveryKey, SkipPower}
	takeovers    = []string{TakeoverOK, TakeoverPolicyLocked, TakeoverNotAttempted}
	bitlockerOut = []string{BitLockerOn, BitLockerSuspended, BitLockerOff, BitLockerUnknown}

	sha256Pattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	uuidPattern      = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	errorCodePattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)
)

// IsLane reports whether s is one of the four lanes.
func IsLane(s string) bool { return contains(allLanes, s) }

// IsCategory reports whether s is one of the four categories.
func IsCategory(s string) bool { return contains(allCategories, s) }

// IsFlashCategory reports whether a category writes firmware: these need a
// reboot Breeze controls, AC power, a current recovery key and the flash guard.
func IsFlashCategory(s string) bool { return s == CategoryBIOS || s == CategoryFirmware }

// VersionRange is a half-open version interval [Min, MaxExclusive).
type VersionRange struct {
	Min          string `json:"min"`
	MaxExclusive string `json:"maxExclusive"`
}

// Prerequisite is one runtime a tool needs before it installs.
type Prerequisite struct {
	Name       string `json:"name"`
	MinVersion string `json:"minVersion"`
	URL        string `json:"url"`
	SHA256     string `json:"sha256"`
}

// ToolSpec is what the API says about the tool to use. It can narrow what the
// agent runs, never widen it: hosts and publishers come from allowlist.json, and
// the lane's compiled range bounds any version the payload names.
type ToolSpec struct {
	Version        string         `json:"version"`
	MinSafeVersion string         `json:"minSafeVersion"`
	SupportedRange VersionRange   `json:"supportedRange"`
	URL            string         `json:"url"`
	SHA256         string         `json:"sha256"`
	Prerequisites  []Prerequisite `json:"prerequisites"`
}

// RunRequest is the oem_update_run payload (oemUpdateRunPayloadSchema). CommandID
// is not part of the payload; the handler fills it in.
type RunRequest struct {
	CommandID            string    `json:"-"`
	Lane                 string    `json:"lane"`
	Trigger              string    `json:"trigger"`
	OccurrenceKey        *string   `json:"occurrenceKey"`
	Categories           []string  `json:"categories"`
	BlockedUpdateIDs     []string  `json:"blockedUpdateIds"`
	RebootControlled     bool      `json:"rebootControlled"`
	NotAfter             time.Time `json:"-"`
	EscrowedProtectorIDs []string  `json:"escrowedProtectorIds"`
	Tool                 *ToolSpec `json:"tool"`
}

// wireRunRequest carries every field as a pointer so a missing required key is
// told apart from its zero value.
type wireRunRequest struct {
	Lane                 *string   `json:"lane"`
	Trigger              *string   `json:"trigger"`
	OccurrenceKey        *string   `json:"occurrenceKey"`
	Categories           *[]string `json:"categories"`
	BlockedUpdateIDs     *[]string `json:"blockedUpdateIds"`
	RebootControlled     *bool     `json:"rebootControlled"`
	NotAfter             *string   `json:"notAfter"`
	EscrowedProtectorIDs *[]string `json:"escrowedProtectorIds"`
	Tool                 *ToolSpec `json:"tool"`
	toolPresent          bool
}

// ParseRunRequest decodes and validates a payload strictly: an unknown key at
// any depth, a missing key, a value out of bounds or trailing data is refused.
func ParseRunRequest(raw []byte) (RunRequest, error) {
	if len(raw) > maxPayloadBytes {
		return RunRequest{}, fmt.Errorf("payload larger than %d bytes", maxPayloadBytes)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keys); err != nil {
		return RunRequest{}, fmt.Errorf("payload is not an object: %w", err)
	}
	var w wireRunRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&w); err != nil {
		return RunRequest{}, fmt.Errorf("decode payload: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return RunRequest{}, errors.New("trailing data after payload")
	}
	_, w.toolPresent = keys["tool"]
	_, occurrencePresent := keys["occurrenceKey"]

	var req RunRequest
	switch {
	case w.Lane == nil || !IsLane(*w.Lane):
		return req, errors.New("lane is missing or unknown")
	case w.Trigger == nil || (*w.Trigger != TriggerScheduled && *w.Trigger != TriggerOnDemand):
		return req, errors.New("trigger is missing or unknown")
	case !occurrencePresent:
		return req, errors.New("occurrenceKey is missing")
	case w.OccurrenceKey != nil && utf8.RuneCountInString(*w.OccurrenceKey) > maxOccurrenceKeyLen:
		return req, errors.New("occurrenceKey is too long")
	case w.Categories == nil:
		return req, errors.New("categories is missing")
	case w.BlockedUpdateIDs == nil:
		return req, errors.New("blockedUpdateIds is missing")
	case w.RebootControlled == nil:
		return req, errors.New("rebootControlled is missing")
	case w.NotAfter == nil:
		return req, errors.New("notAfter is missing")
	case w.EscrowedProtectorIDs == nil:
		return req, errors.New("escrowedProtectorIds is missing")
	case !w.toolPresent:
		return req, errors.New("tool is missing")
	}
	cats := *w.Categories
	if len(cats) < 1 || len(cats) > len(allCategories) {
		return req, errors.New("categories must hold 1 to 4 entries")
	}
	seen := map[string]bool{}
	for _, c := range cats {
		if !IsCategory(c) {
			return req, fmt.Errorf("unknown category %q", c)
		}
		if seen[c] {
			return req, errors.New("categories must be unique")
		}
		seen[c] = true
	}
	blocked := *w.BlockedUpdateIDs
	if len(blocked) > maxBlockedIDs {
		return req, fmt.Errorf("more than %d blocked ids", maxBlockedIDs)
	}
	for _, id := range blocked {
		if n := utf8.RuneCountInString(id); n < 1 || n > maxBlockedIDLen {
			return req, errors.New("a blocked id must be 1 to 128 characters")
		}
	}
	notAfter, err := time.Parse(time.RFC3339Nano, *w.NotAfter)
	if err != nil {
		return req, fmt.Errorf("notAfter is not an ISO timestamp: %w", err)
	}
	protectors := *w.EscrowedProtectorIDs
	if len(protectors) > maxProtectorIDs {
		return req, fmt.Errorf("more than %d escrowed protector ids", maxProtectorIDs)
	}
	for _, id := range protectors {
		if !uuidPattern.MatchString(id) {
			return req, errors.New("an escrowed protector id is not a uuid")
		}
	}
	if w.Tool != nil {
		if err := w.Tool.validate(); err != nil {
			return req, fmt.Errorf("tool: %w", err)
		}
	}
	return RunRequest{
		Lane:                 *w.Lane,
		Trigger:              *w.Trigger,
		OccurrenceKey:        w.OccurrenceKey,
		Categories:           cats,
		BlockedUpdateIDs:     blocked,
		RebootControlled:     *w.RebootControlled,
		NotAfter:             notAfter,
		EscrowedProtectorIDs: protectors,
		Tool:                 w.Tool,
	}, nil
}

func (t *ToolSpec) validate() error {
	for name, v := range map[string]string{
		"version": t.Version, "minSafeVersion": t.MinSafeVersion,
		"supportedRange.min": t.SupportedRange.Min, "supportedRange.maxExclusive": t.SupportedRange.MaxExclusive,
	} {
		if err := validVersionText(v); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
	}
	if err := validHTTPSURL(t.URL); err != nil {
		return fmt.Errorf("url: %w", err)
	}
	if !sha256Pattern.MatchString(t.SHA256) {
		return errors.New("sha256 must be 64 lowercase hex characters")
	}
	if t.Prerequisites == nil {
		return errors.New("prerequisites is missing")
	}
	if len(t.Prerequisites) > maxPrerequisites {
		return fmt.Errorf("more than %d prerequisites", maxPrerequisites)
	}
	for _, p := range t.Prerequisites {
		if n := utf8.RuneCountInString(p.Name); n < 1 || n > maxPrereqNameLen {
			return errors.New("prerequisite name must be 1 to 64 characters")
		}
		if err := validVersionText(p.MinVersion); err != nil {
			return fmt.Errorf("prerequisite minVersion: %w", err)
		}
		if err := validHTTPSURL(p.URL); err != nil {
			return fmt.Errorf("prerequisite url: %w", err)
		}
		if !sha256Pattern.MatchString(p.SHA256) {
			return errors.New("prerequisite sha256 must be 64 lowercase hex characters")
		}
	}
	return nil
}

func validVersionText(v string) error {
	if n := utf8.RuneCountInString(v); n < 1 || n > maxVersionLen {
		return errors.New("must be 1 to 64 characters")
	}
	if hasControl(v) {
		return errors.New("must not contain control characters")
	}
	return nil
}

func validHTTPSURL(raw string) error {
	if len(raw) > maxURLLen {
		return errors.New("too long")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return err
	}
	if u.Scheme != "https" || u.Host == "" {
		return errors.New("must be an absolute https url")
	}
	return nil
}

// Item is one update the tool reported.
type Item struct {
	Title    string `json:"title"`
	Category string `json:"category"`
	Version  string `json:"version"`
	Result   string `json:"result"`
}

// SkippedCategory records a requested category the agent did not run.
type SkippedCategory struct {
	Category string `json:"category"`
	Reason   string `json:"reason"`
}

// RunResult is the command result (oemUpdateRunResultSchema). Nullable fields
// are pointers without omitempty, so they marshal as null rather than vanish.
type RunResult struct {
	Lane              string            `json:"lane"`
	Outcome           Outcome           `json:"outcome"`
	ToolVersion       *string           `json:"toolVersion"`
	RawExitCode       *int64            `json:"rawExitCode"`
	ErrorCode         *string           `json:"errorCode"`
	RebootRequired    bool              `json:"rebootRequired"`
	ShutdownRequired  bool              `json:"shutdownRequired"`
	Items             []Item            `json:"items"`
	SkippedCategories []SkippedCategory `json:"skippedCategories"`
	Takeover          string            `json:"takeover"`
}

// MarshalJSON writes nil slices as [] because the contract has no null arrays.
func (r RunResult) MarshalJSON() ([]byte, error) {
	type plain RunResult
	p := plain(r)
	if p.Items == nil {
		p.Items = []Item{}
	}
	if p.SkippedCategories == nil {
		p.SkippedCategories = []SkippedCategory{}
	}
	if p.Takeover == "" {
		p.Takeover = TakeoverNotAttempted
	}
	return json.Marshal(p)
}

// Validate applies the result schema's rules.
func (r RunResult) Validate() error {
	if !IsLane(r.Lane) {
		return fmt.Errorf("unknown lane %q", r.Lane)
	}
	if !containsOutcome(r.Outcome) {
		return fmt.Errorf("unknown outcome %q", r.Outcome)
	}
	if r.ToolVersion != nil {
		if err := validToolText(*r.ToolVersion, maxVersionLen); err != nil {
			return fmt.Errorf("toolVersion: %w", err)
		}
	}
	if r.RawExitCode != nil && (*r.RawExitCode < -2147483648 || *r.RawExitCode > 4294967295) {
		return errors.New("rawExitCode is out of range")
	}
	if r.ErrorCode != nil {
		if n := len(*r.ErrorCode); n < 1 || n > maxErrorCodeLen || !errorCodePattern.MatchString(*r.ErrorCode) {
			return errors.New("errorCode must be an identifier of 1 to 64 characters")
		}
	}
	if len(r.Items) > maxItems {
		return fmt.Errorf("more than %d items", maxItems)
	}
	for _, it := range r.Items {
		if err := validToolText(it.Title, maxItemTitle); err != nil {
			return fmt.Errorf("item title: %w", err)
		}
		if err := validToolText(it.Version, maxVersionLen); err != nil {
			return fmt.Errorf("item version: %w", err)
		}
		if !IsCategory(it.Category) || !contains(itemResults, it.Result) {
			return errors.New("item has an unknown category or result")
		}
	}
	if len(r.SkippedCategories) > len(allCategories) {
		return errors.New("more than 4 skipped categories")
	}
	for _, s := range r.SkippedCategories {
		if !IsCategory(s.Category) || !contains(skipReasons, s.Reason) {
			return errors.New("skipped category has an unknown category or reason")
		}
	}
	takeover := r.Takeover
	if takeover == "" {
		takeover = TakeoverNotAttempted
	}
	if !contains(takeovers, takeover) {
		return fmt.Errorf("unknown takeover %q", r.Takeover)
	}
	return nil
}

// BitLocker states reported after a reboot.
const (
	BitLockerOn        = "on"
	BitLockerSuspended = "suspended"
	BitLockerOff       = "off"
	BitLockerUnknown   = "unknown"
)

// Verification is the post-reboot report (oemUpdateVerificationSchema).
type Verification struct {
	CommandID        string  `json:"commandId"`
	BitlockerAfter   string  `json:"bitlockerAfter"`
	BiosVersionAfter *string `json:"biosVersionAfter"`
}

// Validate applies the verification schema's rules.
func (v Verification) Validate() error {
	if !uuidPattern.MatchString(v.CommandID) {
		return errors.New("commandId is not a uuid")
	}
	if !contains(bitlockerOut, v.BitlockerAfter) {
		return fmt.Errorf("unknown bitlockerAfter %q", v.BitlockerAfter)
	}
	if v.BiosVersionAfter != nil {
		if err := validToolText(*v.BiosVersionAfter, maxVersionLen); err != nil {
			return fmt.Errorf("biosVersionAfter: %w", err)
		}
	}
	return nil
}

func validToolText(s string, max int) error {
	if utf8.RuneCountInString(s) > max {
		return fmt.Errorf("longer than %d characters", max)
	}
	if hasControl(s) {
		return errors.New("contains control characters")
	}
	return nil
}

// hasControl matches the contract's NO_CONTROL_CHARS: U+0000–U+001F and U+007F.
func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// sanitizeToolText makes untrusted tool output fit the contract: invalid UTF-8
// becomes U+FFFD, control characters (the contract's set, plus other Unicode
// controls a terminal would act on) are dropped, surrounding space is trimmed,
// and the result is cut to max code points.
func sanitizeToolText(s string, max int) string {
	s = strings.ToValidUTF8(s, "�")
	var b strings.Builder
	n := 0
	for _, r := range s {
		if r < 0x20 || r == 0x7f || (unicode.IsControl(r) && r != '�') {
			continue
		}
		b.WriteRune(r)
		n++
		if n >= max+64 { // enough to trim, bounded work on hostile input
			break
		}
	}
	out := strings.TrimSpace(b.String())
	if utf8.RuneCountInString(out) > max {
		out = string([]rune(out)[:max])
	}
	return out
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func containsOutcome(o Outcome) bool {
	for _, v := range allOutcomes {
		if v == o {
			return true
		}
	}
	return false
}

func strPtr(s string) *string { return &s }

func int64Ptr(n int64) *int64 { return &n }

// ExecSpec is one process to run.
type ExecSpec struct {
	// Path is the absolute executable path, already verified by the caller.
	Path string
	Args []string
}

// ExecResult is how a process ended.
type ExecResult struct {
	ExitCode int64
}

// Exec runs vendor processes. It must start Path itself (no shell, no PATH
// lookup), honour ctx by killing the process, and return ctx.Err() when it did.
// The production Exec goes through procspawn.
type Exec interface {
	Run(ctx context.Context, spec ExecSpec) (ExecResult, error)
}

// LaneAllowlist is what one lane may fetch and run, compiled into the agent.
type LaneAllowlist struct {
	Publishers []string `json:"publishers"`
	Hosts      []string `json:"hosts"`
}

// FilterPlan is the lane's reading of the categories and blocked ids it will run.
type FilterPlan struct {
	Categories []string
	BlockedIDs []string
	// WorkDir is an agent-owned directory for the tool's logs and reports. The
	// runner fills it in after Filter.
	WorkDir string
}

// HasFlash reports whether the plan writes firmware.
func (p FilterPlan) HasFlash() bool {
	for _, c := range p.Categories {
		if IsFlashCategory(c) {
			return true
		}
	}
	return false
}

// PrerequisiteHandler is how a lane installs and detects one named
// prerequisite. A name the lane does not know is refused: the payload cannot
// make the agent install arbitrary software, even signed.
type PrerequisiteHandler struct {
	// Installed returns the highest installed version, or "" when absent.
	Installed func() string
	// InstallArgs are the silent-install arguments for the downloaded installer.
	InstallArgs func(installer, logPath string) []string
}

// Lane is one vendor's update path.
type Lane interface {
	ID() string
	Gate() *ToolGate
	Allow() LaneAllowlist
	// Range is the compiled supported range. The payload can narrow it, never
	// widen it: a vulnerable or unknown tool version cannot be run by asking.
	Range() VersionRange
	Filter(cats []string, blocked []string) (FilterPlan, error)
	Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error)
	// SkippedForNoReboot lists the categories that need a reboot Breeze controls.
	SkippedForNoReboot() []string
	// InstallArgs are the silent-install arguments for the tool's installer.
	InstallArgs(installer, logPath string) []string
	// Prerequisite returns the handler for a named prerequisite.
	Prerequisite(name string) (PrerequisiteHandler, bool)
}
