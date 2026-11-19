// Package observe is the read-only `oem_observe` command (#11065, observe-first
// amendment §1.2 and §2). It reports what a Surface, HP or Lenovo machine has:
// identity, firmware, power, BitLocker, vendor tooling, conflicting vendor apps,
// pending Windows Update drivers (Surface) and one passive vendor catalog read
// (HP HEAD, Lenovo GET). It writes, installs, flashes and reboots nothing.
//
// That is a structural guarantee, not a branch: this package does not import
// the oemupdates root package (fetch, install, runner, marker, takeover), the
// flash guard, rollback, safe mode, the updater, self-uninstall or any reboot
// code, and spawns no process of its own. observe_structure_test.go pins both.
//
// The result mirrors packages/shared/src/validators/oemObserve.ts. Every key is
// required (nullable, never optional); every string is bounded and free of
// control characters; a path is reduced to a location class here, on the agent;
// the whole result is at most MaxResultBytes. The goldens in testdata/wire are
// read by both the vitest suite and this package's tests.
package observe

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("oemobserve")

// SchemaVersion is the result's `schema` literal.
const SchemaVersion = 1

// MaxResultBytes is OEM_OBSERVE_RESULT_MAX_BYTES.
const MaxResultBytes = 32 * 1024

// Lanes observe can read. Dell has no observe stage.
const (
	LaneSurface = "surface"
	LaneHP      = "hp"
	LaneLenovo  = "lenovo"
)

// LevelPassive is the only observe level. "scan" (fetch the vendor tool and run
// its analysis) is D-OEM-2, declined, and not in the contract.
const LevelPassive = "passive"

// List and string bounds, as the schema states them.
const (
	maxTools          = 12
	maxConflicts      = 8
	maxErrors         = 16
	maxSurfaceUpdates = 50
	maxCategories     = 32
	maxEscrowedIDs    = 16
	maxCount          = 100_000

	maxAgentVersion  = 32
	maxOSBuild       = 32
	maxSMBIOSText    = 64
	maxBaseboard     = 32
	maxBIOSVersion   = 64
	maxToolVersion   = 64
	maxPublisher     = 128
	maxUpdateTitle   = 200
	maxUpdateID      = 64
	maxDriverMaker   = 128
	maxDriverClass   = 64
	maxDriverModel   = 200
	maxDriverProv    = 128
	maxCategoryName  = 96
	maxErrorStep     = 32
	maxErrorCode     = 64
	fallbackAgentVer = "unknown"
)

// Closed lists from the contract.
const (
	ToolHPIA                = "hpia"
	ToolHPCMSL              = "hp_cmsl"
	ToolLenovoSystemUpdate  = "lenovo_system_update"
	ToolLenovoThinInstaller = "lenovo_thin_installer"
	ToolLenovoLSUClient     = "lenovo_lsuclient"
	ToolLenovoClientUpdate  = "lenovo_client_update"

	ConflictHPSupportAssistant      = "hp_support_assistant"
	ConflictLenovoVantage           = "lenovo_vantage"
	ConflictLenovoCommercialVantage = "lenovo_commercial_vantage"
	ConflictLenovoSystemUpdate      = "lenovo_system_update"
	ConflictDellSupportAssist       = "dell_supportassist"

	LocationProgramFiles = "program_files"
	LocationAgentDir     = "agent_dir"
	LocationWindowsApps  = "windows_apps"
	LocationOther        = "other"

	SelectDriver   = "driver"
	SelectFirmware = "firmware"
	SelectNone     = "none"
)

var (
	toolNames     = setOf(ToolHPIA, ToolHPCMSL, ToolLenovoSystemUpdate, ToolLenovoThinInstaller, ToolLenovoLSUClient, ToolLenovoClientUpdate)
	conflictNames = setOf(ConflictHPSupportAssistant, ConflictLenovoVantage, ConflictLenovoCommercialVantage, ConflictLenovoSystemUpdate, ConflictDellSupportAssist)
	locations     = setOf(LocationProgramFiles, LocationAgentDir, LocationWindowsApps, LocationOther)
	archs         = setOf("amd64", "arm64", "x86", "unknown")
	chassisKinds  = setOf("desktop", "laptop", "tablet", "convertible", "detachable", "all_in_one", "other", "unknown")
	acLines       = setOf("on", "off", "unknown")
	protections   = setOf("on", "off", "suspended", "unknown")
	wuStates      = setOf("ok", "failed", "service_disabled")
	policyStates  = setOf("absent", "present", "unreadable")
	selections    = setOf(SelectDriver, SelectFirmware, SelectNone)
	families      = setOf("thinkpad", "thinkcentre", "thinkstation", "ideapad", "other", "unknown")
	windowsVers   = setOf("10", "11")

	identifierRe  = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)
	isoDateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	machineTypeRe = regexp.MustCompile(`^[A-Z0-9]{4}$`)
	// canonicalUUIDRe is the 8-4-4-4-12 form only: braces, urn: and bare hex
	// forms that looser parsers accept are refused, as the API never sends them.
	canonicalUUIDRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	biosDateRe      = regexp.MustCompile(`^(\d{1,2})/(\d{1,2})/(\d{4})$`)
)

func setOf(values ...string) map[string]bool {
	m := make(map[string]bool, len(values))
	for _, v := range values {
		m[v] = true
	}
	return m
}

// Request is the `oem_observe` payload.
type Request struct {
	Lane                 string
	ObserveLevel         string
	EscrowedProtectorIDs []string
}

// wireRequest uses pointers so a missing key is told apart from a zero value:
// every key is required.
type wireRequest struct {
	Lane                 *string   `json:"lane"`
	ObserveLevel         *string   `json:"observeLevel"`
	EscrowedProtectorIDs *[]string `json:"escrowedProtectorIds"`
}

// ParseRequest reads the payload strictly: no unknown key, no missing key, no
// trailing data, a known lane, the passive level only, and at most 16
// canonical UUIDs. The error never repeats a payload value.
func ParseRequest(raw []byte) (Request, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	var w wireRequest
	if err := dec.Decode(&w); err != nil {
		return Request{}, fmt.Errorf("oem_observe payload: %w", err)
	}
	if dec.More() {
		return Request{}, errors.New("oem_observe payload: trailing data")
	}
	if w.Lane == nil || w.ObserveLevel == nil || w.EscrowedProtectorIDs == nil {
		return Request{}, errors.New("oem_observe payload: a required key is missing or null")
	}
	switch *w.Lane {
	case LaneSurface, LaneHP, LaneLenovo:
	default:
		return Request{}, errors.New("oem_observe payload: unknown lane")
	}
	if *w.ObserveLevel != LevelPassive {
		return Request{}, errors.New("oem_observe payload: only the passive observe level is supported")
	}
	ids := *w.EscrowedProtectorIDs
	if len(ids) > maxEscrowedIDs {
		return Request{}, fmt.Errorf("oem_observe payload: more than %d escrowed protector ids", maxEscrowedIDs)
	}
	for _, id := range ids {
		if !canonicalUUIDRe.MatchString(id) {
			return Request{}, errors.New("oem_observe payload: an escrowed protector id is not a uuid")
		}
	}
	return Request{Lane: *w.Lane, ObserveLevel: *w.ObserveLevel, EscrowedProtectorIDs: append([]string(nil), ids...)}, nil
}

// Result is the observation. Exactly one of Surface, HP and Lenovo is set, and
// it matches Lane.
type Result struct {
	Schema        int        `json:"schema"`
	Lane          string     `json:"lane"`
	AgentVersion  string     `json:"agentVersion"`
	NativeArch    string     `json:"nativeArch"`
	OSBuild       *string    `json:"osBuild"`
	SMBIOS        SMBIOS     `json:"smbios"`
	BIOS          BIOS       `json:"bios"`
	Chassis       string     `json:"chassis"`
	Power         Power      `json:"power"`
	BitLocker     BitLocker  `json:"bitlocker"`
	PendingReboot *bool      `json:"pendingReboot"`
	Tools         []Tool     `json:"tools"`
	Conflicts     []Conflict `json:"conflicts"`
	Errors        []StepErr  `json:"errors"`
	Truncated     bool       `json:"truncated"`

	Surface *SurfaceBlock `json:"surface,omitempty"`
	HP      *HPBlock      `json:"hp,omitempty"`
	Lenovo  *LenovoBlock  `json:"lenovo,omitempty"`
}

// SMBIOS is the identity strings. No serial, UUID or asset tag is read.
type SMBIOS struct {
	Manufacturer     *string `json:"manufacturer"`
	Model            *string `json:"model"`
	SystemSKU        *string `json:"systemSku"`
	Family           *string `json:"family"`
	BaseboardProduct *string `json:"baseboardProduct"`
}

// BIOS is the firmware version and its date as YYYY-MM-DD.
type BIOS struct {
	Version     *string `json:"version"`
	ReleaseDate *string `json:"releaseDate"`
}

// Power is SYSTEM_POWER_STATUS as raw bytes, so 128 and 255 are seen as they are.
type Power struct {
	ACLine         string `json:"acLine"`
	BatteryFlag    *int   `json:"batteryFlag"`
	BatteryPercent *int   `json:"batteryPercent"`
}

// BitLocker is the OS volume's state. Never key material.
type BitLocker struct {
	Protection              string `json:"protection"`
	PCR7Bound               *bool  `json:"pcr7Bound"`
	ActiveProtectorEscrowed *bool  `json:"activeProtectorEscrowed"`
}

// Tool is vendor tooling Breeze could drive: presence and version only.
type Tool struct {
	Name           string  `json:"name"`
	Version        *string `json:"version"`
	Publisher      *string `json:"publisher"`
	SignatureValid *bool   `json:"signatureValid"`
	Location       string  `json:"location"`
}

// Conflict is a resident vendor app that could fight a Breeze run.
type Conflict struct {
	Name    string  `json:"name"`
	Version *string `json:"version"`
}

// StepErr names a read that failed, by identifiers only. Never error text.
type StepErr struct {
	Step string `json:"step"`
	Code string `json:"code"`
}

// SurfaceBlock is the Windows Update driver search and the policy beside it.
type SurfaceBlock struct {
	WindowsUpdate        string          `json:"windowsUpdate"`
	ExcludeWUDriversInQU PolicyValue     `json:"excludeWUDriversInQualityUpdate"`
	Updates              []SurfaceUpdate `json:"updates"`
}

// PolicyValue is a DWORD policy read.
type PolicyValue struct {
	State string `json:"state"`
	Value *int64 `json:"value"`
}

// SurfaceUpdate is one pending driver or firmware update and what the shipped
// Surface filter would do with it.
type SurfaceUpdate struct {
	Title              string  `json:"title"`
	UpdateID           string  `json:"updateId"`
	DriverManufacturer *string `json:"driverManufacturer"`
	DriverClass        *string `json:"driverClass"`
	DriverModel        *string `json:"driverModel"`
	DriverProvider     *string `json:"driverProvider"`
	LaneWouldSelect    string  `json:"laneWouldSelect"`
}

// HPBlock is HP's business-BIOS marker and the platform catalog probe.
type HPBlock struct {
	InstrumentedBIOSNamespace *bool            `json:"instrumentedBiosNamespace"`
	PlatformCatalog           *PlatformCatalog `json:"platformCatalog"`
}

// PlatformCatalog is one HEAD's status; null on a network error.
type PlatformCatalog struct {
	Status *int `json:"status"`
}

// LenovoBlock is the machine type, family and the catalog read.
type LenovoBlock struct {
	MachineType *string        `json:"machineType"`
	Family      string         `json:"family"`
	Catalog     *LenovoCatalog `json:"catalog"`
}

// LenovoCatalog counts the catalog by Lenovo's category text.
type LenovoCatalog struct {
	Status       *int       `json:"status"`
	Windows      *string    `json:"windows"`
	PackageCount int        `json:"packageCount"`
	Categories   []Category `json:"categories"`
	BIOSListed   bool       `json:"biosListed"`
	Truncated    bool       `json:"truncated"`
}

// Category is one distinct category text and how many packages carry it.
type Category struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// newResult is a result with every field at its "not read" value and the
// lane's own block present.
func newResult(lane, agentVersion string) Result {
	r := Result{
		Schema:       SchemaVersion,
		Lane:         lane,
		AgentVersion: agentVersion,
		NativeArch:   "unknown",
		Chassis:      "unknown",
		Power:        Power{ACLine: "unknown"},
		BitLocker:    BitLocker{Protection: "unknown"},
		Tools:        []Tool{},
		Conflicts:    []Conflict{},
		Errors:       []StepErr{},
	}
	switch lane {
	case LaneSurface:
		r.Surface = &SurfaceBlock{WindowsUpdate: "failed", ExcludeWUDriversInQU: PolicyValue{State: "unreadable"}, Updates: []SurfaceUpdate{}}
	case LaneHP:
		r.HP = &HPBlock{}
	case LaneLenovo:
		r.Lenovo = &LenovoBlock{Family: "unknown"}
	}
	return r
}

// addError records a failed read. Bound drops an entry that is not made of
// identifiers, so a slip that passes error text never reaches the wire.
func (r *Result) addError(step, code string) {
	r.Errors = append(r.Errors, StepErr{Step: step, Code: code})
}

// cleanText makes untrusted device or catalog text safe for the wire: valid
// UTF-8, no C0 control character or DEL, trimmed, and at most max UTF-16 code
// units without splitting a surrogate pair. Counting UTF-16 units satisfies the
// schema whether it counts units or code points.
func cleanText(s string, max int) string {
	s = strings.ToValidUTF8(s, "�")
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	units := 0
	for i, r := range s {
		n := utf16.RuneLen(r)
		if n < 0 {
			n = 1
		}
		if units+n > max {
			return strings.TrimSpace(s[:i])
		}
		units += n
	}
	return s
}

// optText is cleanText, with an empty result as null.
func optText(s string, max int) *string {
	c := cleanText(s, max)
	if c == "" {
		return nil
	}
	return &c
}

func reText(p *string, max int) *string {
	if p == nil {
		return nil
	}
	return optText(*p, max)
}

// normalizeBIOSDate turns the registry's MM/DD/YYYY into YYYY-MM-DD. Anything
// else, or a date that does not exist, is null.
func normalizeBIOSDate(s string) *string {
	m := biosDateRe.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return nil
	}
	t, err := time.Parse("1/2/2006", m[1]+"/"+m[2]+"/"+m[3])
	if err != nil {
		return nil
	}
	out := t.Format("2006-01-02")
	return &out
}

// Bound enforces every bound the schema states, normalises absent lists to
// empty ones, and finally cuts list tails until the serialized result fits
// MaxResultBytes. Any list cut sets Truncated.
func Bound(r *Result) {
	r.Schema = SchemaVersion
	r.AgentVersion = cleanText(r.AgentVersion, maxAgentVersion)
	if r.AgentVersion == "" {
		r.AgentVersion = fallbackAgentVer
	}
	r.OSBuild = reText(r.OSBuild, maxOSBuild)
	r.SMBIOS = SMBIOS{
		Manufacturer:     reText(r.SMBIOS.Manufacturer, maxSMBIOSText),
		Model:            reText(r.SMBIOS.Model, maxSMBIOSText),
		SystemSKU:        reText(r.SMBIOS.SystemSKU, maxSMBIOSText),
		Family:           reText(r.SMBIOS.Family, maxSMBIOSText),
		BaseboardProduct: reText(r.SMBIOS.BaseboardProduct, maxBaseboard),
	}
	r.BIOS.Version = reText(r.BIOS.Version, maxBIOSVersion)
	if r.BIOS.ReleaseDate != nil && !isoDateRe.MatchString(*r.BIOS.ReleaseDate) {
		r.BIOS.ReleaseDate = nil
	}
	if r.Power.BatteryFlag != nil && (*r.Power.BatteryFlag < 0 || *r.Power.BatteryFlag > 255) {
		r.Power.BatteryFlag = nil
	}
	if r.Power.BatteryPercent != nil && (*r.Power.BatteryPercent < 0 || *r.Power.BatteryPercent > 255) {
		r.Power.BatteryPercent = nil
	}

	tools := []Tool{}
	for _, t := range r.Tools {
		if !toolNames[t.Name] || !locations[t.Location] {
			continue
		}
		t.Version, t.Publisher = reText(t.Version, maxToolVersion), reText(t.Publisher, maxPublisher)
		tools = append(tools, t)
	}
	r.Tools = capList(r, tools, maxTools)

	conflicts := []Conflict{}
	for _, c := range r.Conflicts {
		if !conflictNames[c.Name] {
			continue
		}
		c.Version = reText(c.Version, maxToolVersion)
		conflicts = append(conflicts, c)
	}
	r.Conflicts = capList(r, conflicts, maxConflicts)

	errs := []StepErr{}
	for _, e := range r.Errors {
		if validIdentifier(e.Step, maxErrorStep) && validIdentifier(e.Code, maxErrorCode) {
			errs = append(errs, e)
		}
	}
	r.Errors = capList(r, errs, maxErrors)

	if r.Surface != nil {
		updates := []SurfaceUpdate{}
		for _, u := range r.Surface.Updates {
			if !selections[u.LaneWouldSelect] {
				u.LaneWouldSelect = SelectNone
			}
			u.Title, u.UpdateID = cleanText(u.Title, maxUpdateTitle), cleanText(u.UpdateID, maxUpdateID)
			u.DriverManufacturer = reText(u.DriverManufacturer, maxDriverMaker)
			u.DriverClass = reText(u.DriverClass, maxDriverClass)
			u.DriverModel = reText(u.DriverModel, maxDriverModel)
			u.DriverProvider = reText(u.DriverProvider, maxDriverProv)
			updates = append(updates, u)
		}
		r.Surface.Updates = capList(r, updates, maxSurfaceUpdates)
	}
	if r.Lenovo != nil {
		if r.Lenovo.MachineType != nil && !machineTypeRe.MatchString(*r.Lenovo.MachineType) {
			r.Lenovo.MachineType = nil
		}
		if c := r.Lenovo.Catalog; c != nil {
			c.PackageCount = clampCount(c.PackageCount)
			cats := []Category{}
			for _, cat := range c.Categories {
				cat.Name = cleanText(cat.Name, maxCategoryName)
				if cat.Name == "" {
					continue
				}
				cat.Count = clampCount(cat.Count)
				cats = append(cats, cat)
			}
			c.Categories = capList(r, cats, maxCategories)
		}
	}
	fitSize(r)
}

func capList[T any](r *Result, list []T, max int) []T {
	if len(list) > max {
		r.Truncated = true
		return list[:max]
	}
	return list
}

func clampCount(n int) int {
	return min(max(n, 0), maxCount)
}

func validIdentifier(s string, max int) bool {
	return s != "" && utf8.RuneCountInString(s) <= max && identifierRe.MatchString(s)
}

// fitSize drops list tails, Surface updates first, until the result fits. The
// fixed part is far under the cap, so the loop always ends.
func fitSize(r *Result) {
	for {
		data, err := json.Marshal(r)
		if err != nil || len(data) <= MaxResultBytes {
			return
		}
		r.Truncated = true
		switch {
		case r.Surface != nil && len(r.Surface.Updates) > 0:
			r.Surface.Updates = r.Surface.Updates[:len(r.Surface.Updates)-1]
		case r.Lenovo != nil && r.Lenovo.Catalog != nil && len(r.Lenovo.Catalog.Categories) > 0:
			r.Lenovo.Catalog.Categories = r.Lenovo.Catalog.Categories[:len(r.Lenovo.Catalog.Categories)-1]
		case len(r.Tools) > 0:
			r.Tools = r.Tools[:len(r.Tools)-1]
		case len(r.Conflicts) > 0:
			r.Conflicts = r.Conflicts[:len(r.Conflicts)-1]
		case len(r.Errors) > 0:
			r.Errors = r.Errors[:len(r.Errors)-1]
		default:
			return
		}
	}
}

// Validate is the Go side of the schema: the handler refuses to send a result
// that fails it. Its messages name fields, never values.
func (r Result) Validate() error {
	var errs []string
	fail := func(format string, args ...any) { errs = append(errs, fmt.Sprintf(format, args...)) }
	text := func(field string, p *string, max int) {
		if p != nil && !validText(*p, max) {
			fail("%s is not bounded clean text", field)
		}
	}
	if r.Schema != SchemaVersion {
		fail("schema")
	}
	if r.AgentVersion == "" || !validText(r.AgentVersion, maxAgentVersion) {
		fail("agentVersion")
	}
	if !archs[r.NativeArch] {
		fail("nativeArch")
	}
	text("osBuild", r.OSBuild, maxOSBuild)
	text("smbios.manufacturer", r.SMBIOS.Manufacturer, maxSMBIOSText)
	text("smbios.model", r.SMBIOS.Model, maxSMBIOSText)
	text("smbios.systemSku", r.SMBIOS.SystemSKU, maxSMBIOSText)
	text("smbios.family", r.SMBIOS.Family, maxSMBIOSText)
	text("smbios.baseboardProduct", r.SMBIOS.BaseboardProduct, maxBaseboard)
	text("bios.version", r.BIOS.Version, maxBIOSVersion)
	if r.BIOS.ReleaseDate != nil && !isoDateRe.MatchString(*r.BIOS.ReleaseDate) {
		fail("bios.releaseDate")
	}
	if !chassisKinds[r.Chassis] {
		fail("chassis")
	}
	if !acLines[r.Power.ACLine] {
		fail("power.acLine")
	}
	for name, p := range map[string]*int{"power.batteryFlag": r.Power.BatteryFlag, "power.batteryPercent": r.Power.BatteryPercent} {
		if p != nil && (*p < 0 || *p > 255) {
			fail("%s", name)
		}
	}
	if !protections[r.BitLocker.Protection] {
		fail("bitlocker.protection")
	}
	if r.Tools == nil || len(r.Tools) > maxTools {
		fail("tools")
	}
	for _, t := range r.Tools {
		if !toolNames[t.Name] || !locations[t.Location] {
			fail("tools[].name or location")
		}
		text("tools[].version", t.Version, maxToolVersion)
		text("tools[].publisher", t.Publisher, maxPublisher)
	}
	if r.Conflicts == nil || len(r.Conflicts) > maxConflicts {
		fail("conflicts")
	}
	for _, c := range r.Conflicts {
		if !conflictNames[c.Name] {
			fail("conflicts[].name")
		}
		text("conflicts[].version", c.Version, maxToolVersion)
	}
	if r.Errors == nil || len(r.Errors) > maxErrors {
		fail("errors")
	}
	for _, e := range r.Errors {
		if !validIdentifier(e.Step, maxErrorStep) || !validIdentifier(e.Code, maxErrorCode) {
			fail("errors[] is not identifiers")
		}
	}
	blocks := 0
	if r.Surface != nil {
		blocks++
		if r.Lane != LaneSurface {
			fail("surface block on lane %s", r.Lane)
		}
		r.Surface.validate(fail, text)
	}
	if r.HP != nil {
		blocks++
		if r.Lane != LaneHP {
			fail("hp block on lane %s", r.Lane)
		}
		if c := r.HP.PlatformCatalog; c != nil && !validStatus(c.Status) {
			fail("hp.platformCatalog.status")
		}
	}
	if r.Lenovo != nil {
		blocks++
		if r.Lane != LaneLenovo {
			fail("lenovo block on lane %s", r.Lane)
		}
		r.Lenovo.validate(fail)
	}
	if blocks != 1 {
		fail("exactly one lane block is required, found %d", blocks)
	}
	if data, err := json.Marshal(r); err != nil || len(data) > MaxResultBytes {
		fail("the result is over %d bytes", MaxResultBytes)
	}
	if len(errs) > 0 {
		return fmt.Errorf("oem_observe result: %s", strings.Join(errs, "; "))
	}
	return nil
}

func (s *SurfaceBlock) validate(fail func(string, ...any), text func(string, *string, int)) {
	if !wuStates[s.WindowsUpdate] {
		fail("surface.windowsUpdate")
	}
	if !policyStates[s.ExcludeWUDriversInQU.State] {
		fail("surface.excludeWUDriversInQualityUpdate.state")
	}
	if s.Updates == nil || len(s.Updates) > maxSurfaceUpdates {
		fail("surface.updates")
	}
	for _, u := range s.Updates {
		if !validText(u.Title, maxUpdateTitle) || !validText(u.UpdateID, maxUpdateID) || !selections[u.LaneWouldSelect] {
			fail("surface.updates[]")
		}
		text("surface.updates[].driverManufacturer", u.DriverManufacturer, maxDriverMaker)
		text("surface.updates[].driverClass", u.DriverClass, maxDriverClass)
		text("surface.updates[].driverModel", u.DriverModel, maxDriverModel)
		text("surface.updates[].driverProvider", u.DriverProvider, maxDriverProv)
	}
}

func (l *LenovoBlock) validate(fail func(string, ...any)) {
	if l.MachineType != nil && !machineTypeRe.MatchString(*l.MachineType) {
		fail("lenovo.machineType")
	}
	if !families[l.Family] {
		fail("lenovo.family")
	}
	c := l.Catalog
	if c == nil {
		return
	}
	if !validStatus(c.Status) {
		fail("lenovo.catalog.status")
	}
	if c.Windows != nil && !windowsVers[*c.Windows] {
		fail("lenovo.catalog.windows")
	}
	if c.PackageCount < 0 || c.PackageCount > maxCount {
		fail("lenovo.catalog.packageCount")
	}
	if c.Categories == nil || len(c.Categories) > maxCategories {
		fail("lenovo.catalog.categories")
	}
	for _, cat := range c.Categories {
		if cat.Name == "" || !validText(cat.Name, maxCategoryName) || cat.Count < 0 || cat.Count > maxCount {
			fail("lenovo.catalog.categories[]")
		}
	}
}

func validStatus(p *int) bool {
	return p == nil || (*p >= 100 && *p <= 599)
}

// validText is "already clean": cleaning it changes nothing that the schema
// checks (length and control characters).
func validText(s string, max int) bool {
	if !utf8.ValidString(s) || len(utf16.Encode([]rune(s))) > max {
		return false
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}
