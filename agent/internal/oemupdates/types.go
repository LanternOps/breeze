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

	sha256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	// uuidPattern is zod 4's .uuid(): RFC 9562 version 1-8 and variant 10xx,
	// plus the nil and max UUIDs.
	uuidPattern      = regexp.MustCompile(`^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|[fF]{8}-[fF]{4}-[fF]{4}-[fF]{4}-[fF]{12})$`)
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
}

// Exact key sets of the strict zod objects. encoding/json matches keys
// case-insensitively and lets a duplicate key win silently; zod's .strict()
// does neither, so keys are checked byte-exact before the struct decode.
var (
	payloadKeys      = []string{"lane", "trigger", "occurrenceKey", "categories", "blockedUpdateIds", "rebootControlled", "notAfter", "escrowedProtectorIds", "tool"}
	toolKeys         = []string{"version", "minSafeVersion", "supportedRange", "url", "sha256", "prerequisites"}
	rangeKeys        = []string{"min", "maxExclusive"}
	prerequisiteKeys = []string{"name", "minVersion", "url", "sha256"}
)

// exactObject reads a JSON object whose keys must all be in allowed, each at
// most once, compared byte for byte. It returns the raw value of each key.
func exactObject(raw json.RawMessage, allowed []string) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("not an object")
	}
	out := map[string]json.RawMessage{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		if !contains(allowed, key) {
			return nil, fmt.Errorf("unknown key %q", key)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("duplicate key %q", key)
		}
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		out[key] = v
	}
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("trailing data after object")
	}
	return out, nil
}

func checkPayloadKeys(raw []byte) (map[string]json.RawMessage, error) {
	top, err := exactObject(raw, payloadKeys)
	if err != nil {
		return nil, err
	}
	tool, ok := top["tool"]
	if !ok || string(tool) == "null" {
		return top, nil
	}
	tk, err := exactObject(tool, toolKeys)
	if err != nil {
		return nil, fmt.Errorf("tool: %w", err)
	}
	if r, ok := tk["supportedRange"]; ok {
		if _, err := exactObject(r, rangeKeys); err != nil {
			return nil, fmt.Errorf("tool.supportedRange: %w", err)
		}
	}
	if p, ok := tk["prerequisites"]; ok && string(p) != "null" {
		var items []json.RawMessage
		if err := json.Unmarshal(p, &items); err != nil {
			return nil, fmt.Errorf("tool.prerequisites: %w", err)
		}
		for i, it := range items {
			if _, err := exactObject(it, prerequisiteKeys); err != nil {
				return nil, fmt.Errorf("tool.prerequisites[%d]: %w", i, err)
			}
		}
	}
	return top, nil
}

// ParseRunRequest decodes and validates a payload strictly: an unknown,
// case-variant or duplicate key at any depth, a missing key, a value out of
// bounds or trailing data is refused.
func ParseRunRequest(raw []byte) (RunRequest, error) {
	if len(raw) > maxPayloadBytes {
		return RunRequest{}, fmt.Errorf("payload larger than %d bytes", maxPayloadBytes)
	}
	keys, err := checkPayloadKeys(raw)
	if err != nil {
		return RunRequest{}, fmt.Errorf("payload: %w", err)
	}
	var w wireRunRequest
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&w); err != nil {
		return RunRequest{}, fmt.Errorf("decode payload: %w", err)
	}
	for _, k := range payloadKeys {
		if _, ok := keys[k]; !ok {
			return RunRequest{}, fmt.Errorf("%s is missing", k)
		}
	}
	switch {
	case w.Lane == nil, w.Trigger == nil, w.Categories == nil, w.BlockedUpdateIDs == nil,
		w.RebootControlled == nil, w.NotAfter == nil, w.EscrowedProtectorIDs == nil:
		return RunRequest{}, errors.New("a required field is null")
	}
	notAfter, err := time.Parse(time.RFC3339Nano, *w.NotAfter)
	if err != nil {
		return RunRequest{}, fmt.Errorf("notAfter is not an ISO timestamp: %w", err)
	}
	req := RunRequest{
		Lane:                 *w.Lane,
		Trigger:              *w.Trigger,
		OccurrenceKey:        w.OccurrenceKey,
		Categories:           *w.Categories,
		BlockedUpdateIDs:     *w.BlockedUpdateIDs,
		RebootControlled:     *w.RebootControlled,
		NotAfter:             notAfter,
		EscrowedProtectorIDs: *w.EscrowedProtectorIDs,
		Tool:                 w.Tool,
	}
	if err := req.validate(false); err != nil {
		return RunRequest{}, err
	}
	return req, nil
}

// validate applies the payload schema's rules to a request however it was
// built. Run calls it with requireCommandID, because the command id becomes
// the marker's, the flash section's and the verification's key.
func (r RunRequest) validate(requireCommandID bool) error {
	if requireCommandID && !uuidPattern.MatchString(r.CommandID) {
		return errors.New("command id is not a uuid")
	}
	if !IsLane(r.Lane) {
		return errors.New("lane is missing or unknown")
	}
	if r.Trigger != TriggerScheduled && r.Trigger != TriggerOnDemand {
		return errors.New("trigger is missing or unknown")
	}
	if r.OccurrenceKey != nil && utf8.RuneCountInString(*r.OccurrenceKey) > maxOccurrenceKeyLen {
		return errors.New("occurrenceKey is too long")
	}
	if len(r.Categories) < 1 || len(r.Categories) > len(allCategories) {
		return errors.New("categories must hold 1 to 4 entries")
	}
	seen := map[string]bool{}
	for _, c := range r.Categories {
		if !IsCategory(c) {
			return fmt.Errorf("unknown category %q", c)
		}
		if seen[c] {
			return errors.New("categories must be unique")
		}
		seen[c] = true
	}
	if len(r.BlockedUpdateIDs) > maxBlockedIDs {
		return fmt.Errorf("more than %d blocked ids", maxBlockedIDs)
	}
	for _, id := range r.BlockedUpdateIDs {
		if n := utf8.RuneCountInString(id); n < 1 || n > maxBlockedIDLen {
			return errors.New("a blocked id must be 1 to 128 characters")
		}
	}
	if r.NotAfter.IsZero() {
		return errors.New("notAfter is missing")
	}
	if len(r.EscrowedProtectorIDs) > maxProtectorIDs {
		return fmt.Errorf("more than %d escrowed protector ids", maxProtectorIDs)
	}
	for _, id := range r.EscrowedProtectorIDs {
		if !uuidPattern.MatchString(id) {
			return errors.New("an escrowed protector id is not a uuid")
		}
	}
	if r.Tool != nil {
		if err := r.Tool.validate(); err != nil {
			return fmt.Errorf("tool: %w", err)
		}
	}
	return nil
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
	// Allow is this prerequisite's own publishers and hosts, never the tool's.
	Allow LaneAllowlist
	// Installed returns the highest installed version, or "" when absent.
	Installed func() string
	// InstallArgs are the silent-install arguments for the downloaded installer.
	InstallArgs func(installer, logPath string) []string
}

// ToolFreeLane is a lane with no vendor tool to find, verify or install. EnsureTool
// asks it instead of doing any of those, so a payload naming a tool cannot reach a
// download or an install on this lane. Ready returns an empty outcome when the
// lane can run; it must not spawn a process.
//
// toolFree is a marker: this skips every download, range and publisher check, so a
// lane must ask for it by name and cannot get it by having a method called Ready.
type ToolFreeLane interface {
	Lane
	toolFree()
	Ready() (ToolState, Outcome, error)
}

// HardwareCheckedLane is a lane that must refuse a machine that is not its vendor's.
// EnsureTool asks before it fetches or runs anything. It can only refuse, so unlike
// ToolFreeLane it needs no marker. It must not spawn a process.
type HardwareCheckedLane interface {
	Lane
	CheckHardware() (Outcome, error)
}

// Lane is one vendor's update path.
type Lane interface {
	ID() string
	Gate() *ToolGate
	// Allow is the tool installer's and the tool's publishers and hosts.
	Allow() LaneAllowlist
	// ToolVersion reads the version of the tool at path now. The gate's answer
	// is up to a day old and the range is a safety check, so the range is
	// tested against this, not the cache. It must not spawn a process.
	ToolVersion(path string) (string, error)
	// FlashesOutsideFilter reports that a run may write firmware the category
	// filter cannot exclude (Dell docks ignore -updateType). Such a run holds
	// the flash guard and is never killed, whatever categories it asked for.
	FlashesOutsideFilter() bool
	// Range is the compiled supported range. The payload can narrow it, never
	// widen it: a vulnerable or unknown tool version cannot be run by asking.
	Range() VersionRange
	// Filter must be pure: the runner calls it again after gates drop
	// categories, and refuses a plan wider than the request.
	Filter(cats []string, blocked []string) (FilterPlan, error)
	Apply(ctx context.Context, tool ToolState, plan FilterPlan, ex Exec) (RunResult, error)
	// SkippedForNoReboot lists the categories that need a reboot Breeze controls.
	SkippedForNoReboot() []string
	// InstallArgs are the silent-install arguments for the tool's installer.
	InstallArgs(installer, logPath string) []string
	// Prerequisite returns the handler for a named prerequisite.
	Prerequisite(name string) (PrerequisiteHandler, bool)
}
