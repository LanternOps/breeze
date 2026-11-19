// Package hpwarrantyobserve is the read-only HP warranty observe step (#5511,
// observe-first amendment §2, O3). On an HP machine it reports what HP's
// warranty WMI namespace (root/HP/InstrumentedServices/v1) holds, as shape
// rather than identity, and the prerequisites HP CMSL would need: PowerShell
// 5.1, the TLS 1.2 registry values, winget for SYSTEM, CMSL module directories
// and consumer HP software that may carry warranty data of its own.
//
// It changes nothing. It never runs CMSL's warranty cmdlet, never calls HP, never
// runs winget, never loads or installs a module and never writes WMI or the
// registry. Its only process is one fixed Windows PowerShell script (script.go)
// that reads WMI; the rest are directory listings and registry reads.
// structure_test.go pins that.
//
// What it never reports: a BIOS serial, IdentifyingNumber, UUID, hostname,
// product number, customer or contact value, or a raw dump. A WMI value is
// reported only under a property name that passes the deny-then-allow filter
// (denyPattern, then allowPattern); every other property is reported by name
// and CIM type only.
//
// The result mirrors packages/shared/src/validators/hpWarrantyObserve.ts:
// every key present (null, never omitted), every string bounded and free of
// control characters, versions v-prefixed, the whole at most MaxBytes. The
// goldens in testdata/wire are read by both sides' tests.
package hpwarrantyobserve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	oemobserve "github.com/breeze-rmm/agent/internal/oemupdates/observe"
)

// SchemaVersion is the record's schemaVersion.
const SchemaVersion = 1

// MaxBytes is HP_WARRANTY_OBSERVE_MAX_BYTES.
const MaxBytes = 16 * 1024

// The record's component and message on the agent-log path.
const (
	Component = "hp_warranty_observe"
	Message   = "vendor_observation"
)

// The property-name filter, mirrored by HP_WARRANTY_VALUE_NAME_DENY/ALLOW in
// the shared validator. testdata/wire/name_filter.json pins both.
const (
	denyPattern         = `(?i)serial|product.?(number|no)|sku|uuid|identif|customer|email|name|address|phone|country`
	allowPattern        = `(?i)(start|end|expir\w*)\w*date|type|status|desc|level|coverage|offer|lastupdat|cache|timestamp`
	propertyNamePattern = `^[A-Za-z_][A-Za-z0-9_]{0,63}$`
)

// Bounds, as the schema states them.
const (
	maxClasses     = 32
	maxProperties  = 64
	maxRows        = 25
	maxValueLen    = 64
	maxTextLen     = 64
	maxModules     = 16
	maxVersions    = 8
	maxConflicts   = 4
	maxErrors      = 16
	maxCount       = 100_000
	maxVersionText = 32
)

// Namespace and class states.
const (
	StatePresent      = "present"
	StateAbsent       = "absent"
	StateAccessDenied = "access_denied"
	StateError        = "error"
	StateNotChecked   = "not_checked"
)

// Registry value states.
const (
	RegEnabled    = "enabled"
	RegDisabled   = "disabled"
	RegOther      = "other"
	RegAbsent     = "absent"
	RegUnreadable = "unreadable"
)

var (
	denyRe         = regexp.MustCompile(denyPattern)
	allowRe        = regexp.MustCompile(allowPattern)
	propertyNameRe = regexp.MustCompile(propertyNamePattern)
	cimTypeRe      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9]{0,23}$`)
	errorCodeRe    = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
	dateNameRe     = regexp.MustCompile(`(?i)date|expir|lastupdat|timestamp|cache`)
	dottedVerRe    = regexp.MustCompile(`^\d{1,9}(\.\d{1,9}){0,3}$`)
	moduleDirRe    = regexp.MustCompile(`(?i)^(?:HPCMSL|HP\.[A-Za-z0-9.]{1,61})$`)
	moduleVerRe    = regexp.MustCompile(`^\d{1,9}(\.\d{1,9}){1,3}$`)
	appInstallerRe = regexp.MustCompile(`^Microsoft\.DesktopAppInstaller_(\d{1,9}(?:\.\d{1,9}){1,3})_(x64|arm64|x86|neutral)__8wekyb3d8bbwe$`)

	cimDateTimeRe = regexp.MustCompile(`^\d{14}\.\d{6}[+-]\d{3}$`)
	msJSONDateRe  = regexp.MustCompile(`^/Date\(-?\d{1,15}([+-]\d{4})?\)/$`)
	isoDateRe     = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$`)

	supportAssistantRe = regexp.MustCompile(`(?i)^hp support assistant$`)
	insightsRe         = regexp.MustCompile(`(?i)^hp insights( analytics)?$`)
)

// IsObservableName reports whether a WMI property's VALUE may be reported:
// a plain property name that the deny pattern does not match and the allow
// pattern does. Deny is checked first and always wins.
func IsObservableName(name string) bool {
	return propertyNameRe.MatchString(name) && !denyRe.MatchString(name) && allowRe.MatchString(name)
}

// Observation is the wire record (the `observation` field).
type Observation struct {
	SchemaVersion  int               `json:"schemaVersion"`
	Mode           string            `json:"mode"`
	Model          *string           `json:"model"`
	Family         *string           `json:"family"`
	NativeArch     string            `json:"nativeArch"`
	Namespaces     Namespaces        `json:"namespaces"`
	Classes        *Classes          `json:"classes"`
	HPWarranty     *ClassObservation `json:"hpWarranty"`
	HPEntitlements *ClassObservation `json:"hpEntitlements"`
	CMSL           []Module          `json:"cmsl"`
	PowerShell     PowerShell        `json:"powershell"`
	Winget         Winget            `json:"winget"`
	Conflicts      []Conflict        `json:"conflicts"`
	Errors         []StepError       `json:"errors"`
}

// Namespaces says, for each step of the walk to v1, whether it exists.
type Namespaces struct {
	RootHP               string `json:"rootHp"`
	InstrumentedServices string `json:"instrumentedServices"`
	V1                   string `json:"v1"`
	InstrumentedBIOS     string `json:"instrumentedBios"`
}

// Classes are v1's class names (system classes excluded), sorted.
type Classes struct {
	Total int      `json:"total"`
	Names []string `json:"names"`
}

// ClassObservation is one warranty class: its schema, row count, and the
// filtered values of its first rows.
type ClassObservation struct {
	State       string               `json:"state"`
	Properties  []Property           `json:"properties"`
	RowCount    *int                 `json:"rowCount"`
	Rows        []map[string]*string `json:"rows"`
	DateFormats map[string]string    `json:"dateFormats"`
}

// Property is a WMI property's name and CIM type. Never its value.
type Property struct {
	Name    string `json:"name"`
	CIMType string `json:"cimType"`
}

// Module is an HP PowerShell module directory and its version directories.
type Module struct {
	Name     string   `json:"name"`
	Versions []string `json:"versions"`
}

// PowerShell is what CMSL needs from the host.
type PowerShell struct {
	V51                 *bool  `json:"v51"`
	StrongCrypto64      string `json:"strongCrypto64"`
	StrongCrypto32      string `json:"strongCrypto32"`
	SchannelTLS12Client string `json:"schannelTls12Client"`
}

// Winget is whether App Installer's winget.exe is on disk for SYSTEM. It is
// never run.
type Winget struct {
	Present *bool   `json:"present"`
	Version *string `json:"version"`
}

// Conflict is consumer HP software that may hold warranty data of its own.
type Conflict struct {
	Name    string  `json:"name"`
	Version *string `json:"version"`
}

// StepError is a failed step, as an identifier code. Never message text.
type StepError struct {
	Step string `json:"step"`
	Code string `json:"code"`
}

// Registry reads the observer makes. The windows host refuses any other.
const (
	RegPowerShellEngine = `SOFTWARE\Microsoft\PowerShell\3\PowerShellEngine`
	RegNetFx64          = `SOFTWARE\Microsoft\.NETFramework\v4.0.30319`
	RegNetFx32          = `SOFTWARE\WOW6432Node\Microsoft\.NETFramework\v4.0.30319`
	RegSchannelTLS12    = `SYSTEM\CurrentControlSet\Control\SecurityProviders\SCHANNEL\Protocols\TLS 1.2\Client`
)

// Host is every read the observer makes, as plain functions so tests replace
// them. A nil seam reads as unavailable, never as a value.
type Host struct {
	// BIOSInfo, IsWow64Process2, ListDirs, RegularFile, ProgramFiles and
	// ProgramEntries are the vendor-updates observe readers, reused.
	BIOSInfo        func() (oemobserve.BIOSInfo, error)
	IsWow64Process2 func() (processMachine, nativeMachine uint16, err error)
	ListDirs        func(path string) ([]string, error)
	RegularFile     func(path string) bool
	ProgramFiles    func() string
	ProgramEntries  func() ([]oemobserve.ProgramEntry, error)
	// RegistryString and RegistryDWORD read HKLM. present is false when the
	// key or value does not exist.
	RegistryString func(path, name string) (value string, present bool, err error)
	RegistryDWORD  func(path, name string) (value uint64, present bool, err error)
	// RunWMIScript runs the fixed script (script.go) and returns its stdout.
	RunWMIScript func(ctx context.Context) ([]byte, error)
}

// Collect observes this machine. It returns nil when the machine is not HP
// (HPE is not HP) or its manufacturer cannot be read: there is nothing to
// learn there. mode is the fresh hp_cmsl_mode the caller acted on.
func Collect(ctx context.Context, host Host, mode string) *Observation {
	if host.BIOSInfo == nil {
		return nil
	}
	bios, err := host.BIOSInfo()
	if err != nil || !oemobserve.IsHPManufacturer(bios.SystemManufacturer) {
		return nil
	}
	c := &collector{ctx: ctx, host: host}
	o := &Observation{
		SchemaVersion: SchemaVersion,
		Mode:          mode,
		Model:         optText(bios.SystemProductName),
		Family:        optText(bios.SystemFamily),
		Namespaces: Namespaces{
			RootHP: StateNotChecked, InstrumentedServices: StateNotChecked,
			V1: StateNotChecked, InstrumentedBIOS: StateNotChecked,
		},
		CMSL:      []Module{},
		Conflicts: []Conflict{},
		Errors:    []StepError{},
	}
	// c.o first: every step, nativeArch included, may record an error.
	c.o = o
	o.NativeArch = c.nativeArch()
	c.wmi()
	c.cmsl()
	c.powershell()
	c.winget()
	c.conflicts()
	bound(o)
	return o
}

type collector struct {
	ctx  context.Context
	host Host
	o    *Observation
}

func (c *collector) addError(step, code string) {
	if len(c.o.Errors) >= maxErrors {
		return
	}
	if !errorCodeRe.MatchString(code) {
		code = "unrecognized"
	}
	c.o.Errors = append(c.o.Errors, StepError{Step: step, Code: code})
}

// IMAGE_FILE_MACHINE_* values IsWow64Process2 reports.
const (
	machineI386  = 0x014c
	machineAMD64 = 0x8664
	machineARM64 = 0xAA64
)

func (c *collector) nativeArch() string {
	if c.host.IsWow64Process2 == nil {
		return "unknown"
	}
	_, native, err := c.host.IsWow64Process2()
	if err != nil {
		c.addError("arch", "unavailable")
		return "unknown"
	}
	switch native {
	case machineAMD64:
		return "amd64"
	case machineARM64:
		return "arm64"
	case machineI386:
		return "x86"
	}
	return "unknown"
}

// --- WMI -------------------------------------------------------------------

// scriptOutput is what wmiScript prints. Lists tolerate PowerShell 5.1's
// habit of collapsing a one-element array to a scalar.
type scriptOutput struct {
	RootHP  scriptNamespace           `json:"rootHp"`
	ISV     scriptNamespace           `json:"isv"`
	V1      scriptNamespace           `json:"v1"`
	Classes *scriptClasses            `json:"classes"`
	Cls     map[string]scriptClassOut `json:"cls"`
}

type scriptNamespace struct {
	S string            `json:"s"`
	N oneOrMany[string] `json:"n"`
}

type scriptClasses struct {
	S     string            `json:"s"`
	Total int               `json:"total"`
	N     oneOrMany[string] `json:"n"`
}

type scriptClassOut struct {
	S       string                            `json:"s"`
	Props   oneOrMany[scriptProp]             `json:"props"`
	Rows    *int                              `json:"rows"`
	RowsErr *string                           `json:"rowsErr"`
	Values  oneOrMany[map[string]scriptValue] `json:"values"`
}

type scriptProp struct {
	N string `json:"n"`
	T string `json:"t"`
}

type scriptValue struct {
	K string  `json:"k"`
	V *string `json:"v"`
}

// oneOrMany decodes a JSON array or a single bare element.
type oneOrMany[T any] []T

func (l *oneOrMany[T]) UnmarshalJSON(b []byte) error {
	trimmed := strings.TrimSpace(string(b))
	if trimmed == "null" {
		*l = nil
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var many []T
		if err := json.Unmarshal(b, &many); err != nil {
			return err
		}
		*l = many
		return nil
	}
	var one T
	if err := json.Unmarshal(b, &one); err != nil {
		return err
	}
	*l = []T{one}
	return nil
}

// namespaceState maps a script code to a state; anything not present, absent
// or denied is an error, recorded under step.
func (c *collector) namespaceState(step, code string) string {
	switch code {
	case "present":
		return StatePresent
	case "cim_InvalidNamespace", "0x8004100E":
		return StateAbsent
	case "cim_AccessDenied", "0x80041003", "0x80070005":
		return StateAccessDenied
	}
	c.addError(step, code)
	return StateError
}

func (c *collector) classState(step, code string) string {
	switch code {
	case "present":
		return StatePresent
	case "cim_InvalidClass", "cim_NotFound", "0x80041010", "0x80041002":
		return StateAbsent
	case "cim_AccessDenied", "0x80041003", "0x80070005":
		return StateAccessDenied
	}
	c.addError(step, code)
	return StateError
}

func (c *collector) wmi() {
	if c.host.RunWMIScript == nil {
		c.addError("wmi", "unavailable")
		return
	}
	out, err := c.host.RunWMIScript(c.ctx)
	if err != nil {
		code := "script_failed"
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			code = "timeout"
		case errors.Is(err, context.Canceled):
			code = "canceled"
		case errors.Is(err, ErrOutputTooLarge):
			code = "output_too_large"
		case errors.Is(err, ErrCommandRefused):
			code = "refused"
		}
		c.addError("wmi", code)
		return
	}
	var s scriptOutput
	// A UTF-8 console encoding can put a byte-order mark before the JSON.
	out = bytes.TrimPrefix(bytes.TrimSpace(out), []byte("\xef\xbb\xbf"))
	if err := json.Unmarshal(out, &s); err != nil {
		c.addError("wmi", "output_unparsable")
		return
	}
	ns := &c.o.Namespaces
	ns.RootHP = c.namespaceState("wmi_root_hp", s.RootHP.S)
	switch ns.RootHP {
	case StatePresent:
		ns.InstrumentedBIOS = StateAbsent
		for _, child := range s.RootHP.N {
			if strings.EqualFold(child, "InstrumentedBIOS") {
				ns.InstrumentedBIOS = StatePresent
			}
		}
	case StateAbsent:
		ns.InstrumentedBIOS = StateAbsent
	}
	ns.InstrumentedServices = c.namespaceState("wmi_isv", s.ISV.S)
	ns.V1 = c.namespaceState("wmi_v1", s.V1.S)
	if ns.V1 != StatePresent {
		return
	}
	if s.Classes != nil {
		if c.classState("wmi_classes", s.Classes.S) == StatePresent {
			c.o.Classes = boundClasses(s.Classes)
		}
	}
	if out, ok := s.Cls["HP_Warranty"]; ok {
		c.o.HPWarranty = c.class("wmi_hp_warranty", out)
	}
	if out, ok := s.Cls["HP_Entitlements"]; ok {
		c.o.HPEntitlements = c.class("wmi_hp_entitlements", out)
	}
}

func boundClasses(s *scriptClasses) *Classes {
	names := make([]string, 0, len(s.N))
	for _, n := range s.N {
		if propertyNameRe.MatchString(n) && !slices.Contains(names, n) {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	if len(names) > maxClasses {
		names = names[:maxClasses]
	}
	return &Classes{Total: clampCount(s.Total), Names: names}
}

func (c *collector) class(step string, s scriptClassOut) *ClassObservation {
	co := &ClassObservation{
		State:       c.classState(step, s.S),
		Properties:  []Property{},
		Rows:        []map[string]*string{},
		DateFormats: map[string]string{},
	}
	if co.State != StatePresent {
		return co
	}
	var allowed []string
	for _, p := range s.Props {
		if !propertyNameRe.MatchString(p.N) || slices.ContainsFunc(co.Properties, func(q Property) bool { return q.Name == p.N }) {
			continue
		}
		if len(co.Properties) < maxProperties {
			typ := p.T
			if !cimTypeRe.MatchString(typ) {
				typ = "Other"
			}
			co.Properties = append(co.Properties, Property{Name: p.N, CIMType: typ})
		}
		if IsObservableName(p.N) && len(allowed) < maxProperties {
			allowed = append(allowed, p.N)
		}
	}
	if s.RowsErr != nil {
		c.addError(step+"_rows", *s.RowsErr)
		return co
	}
	if s.Rows != nil {
		n := clampCount(*s.Rows)
		co.RowCount = &n
	}
	for _, raw := range s.Values {
		if len(co.Rows) >= maxRows {
			break
		}
		row := map[string]*string{}
		// Go decides what is reported: only allowed names from the class's
		// own schema, whatever else the script printed.
		for _, name := range allowed {
			v, ok := raw[name]
			if !ok {
				continue
			}
			value, format := normalizeValue(v)
			row[name] = value
			if _, seen := co.DateFormats[name]; !seen && format != "" && dateNameRe.MatchString(name) {
				co.DateFormats[name] = format
			}
		}
		co.Rows = append(co.Rows, row)
	}
	return co
}

// normalizeValue bounds a value and, for a non-empty one, classifies its date
// format ("" for a value that cannot be a date).
func normalizeValue(v scriptValue) (*string, string) {
	switch v.K {
	case "null":
		return nil, ""
	case "datetime":
		if v.V == nil {
			return nil, ""
		}
		t, err := time.Parse(time.RFC3339Nano, *v.V)
		if err != nil {
			return nil, ""
		}
		s := t.UTC().Format(time.RFC3339)
		return &s, "cim_datetime"
	case "string":
		if v.V == nil {
			return nil, ""
		}
		s := cleanText(*v.V, maxValueLen)
		if s == "" {
			return &s, ""
		}
		return &s, dateFormat(s)
	case "number", "bool":
		if v.V == nil {
			return nil, ""
		}
		s := cleanText(*v.V, maxValueLen)
		return &s, ""
	case "array":
		s := "<array>"
		return &s, ""
	}
	s := "<other>"
	return &s, ""
}

// dateFormat classifies a raw string value the way W03's date parser must
// handle it.
func dateFormat(s string) string {
	switch {
	case cimDateTimeRe.MatchString(s):
		return "cim_datetime"
	case msJSONDateRe.MatchString(s):
		return "ms_json_date"
	case isoDateRe.MatchString(s):
		return "iso8601"
	}
	return "other"
}

// --- files and registry -----------------------------------------------------

func (c *collector) programFiles() string {
	if c.host.ProgramFiles == nil {
		return ""
	}
	return strings.TrimRight(strings.TrimSpace(c.host.ProgramFiles()), `\/`)
}

// cmsl lists HP module directories under Program Files' Windows PowerShell
// modules and their version directories. Nothing is loaded.
func (c *collector) cmsl() {
	pf := c.programFiles()
	if pf == "" || c.host.ListDirs == nil {
		c.o.CMSL = nil
		c.addError("cmsl", "unavailable")
		return
	}
	root := pf + `\WindowsPowerShell\Modules`
	dirs, err := c.host.ListDirs(root)
	if err != nil {
		c.o.CMSL = nil
		c.addError("cmsl", "dir_unreadable")
		return
	}
	var names []string
	for _, d := range dirs {
		if moduleDirRe.MatchString(d) && len(d) <= maxTextLen {
			names = append(names, d)
		}
	}
	sort.Strings(names)
	if len(names) > maxModules {
		names = names[:maxModules]
	}
	for _, name := range names {
		m := Module{Name: name, Versions: []string{}}
		if vers, err := c.host.ListDirs(root + `\` + name); err == nil {
			for _, v := range vers {
				if moduleVerRe.MatchString(v) && len(m.Versions) < maxVersions {
					if vv := vVersion(v); vv != nil {
						m.Versions = append(m.Versions, *vv)
					}
				}
			}
			sort.Strings(m.Versions)
		} else {
			c.addError("cmsl_versions", "dir_unreadable")
		}
		c.o.CMSL = append(c.o.CMSL, m)
	}
}

func (c *collector) powershell() {
	p := &c.o.PowerShell
	if c.host.RegistryString == nil {
		c.addError("powershell", "unavailable")
	} else if v, present, err := c.host.RegistryString(RegPowerShellEngine, "PowerShellVersion"); err != nil {
		c.addError("powershell", "unreadable")
	} else {
		p.V51 = new(present && strings.HasPrefix(strings.TrimSpace(v), "5.1"))
	}
	p.StrongCrypto64 = c.dword("tls_strong_crypto_64", RegNetFx64, "SchUseStrongCrypto")
	p.StrongCrypto32 = c.dword("tls_strong_crypto_32", RegNetFx32, "SchUseStrongCrypto")
	p.SchannelTLS12Client = c.dword("tls_schannel_12", RegSchannelTLS12, "Enabled")
}

func (c *collector) dword(step, path, name string) string {
	if c.host.RegistryDWORD == nil {
		c.addError(step, "unavailable")
		return RegUnreadable
	}
	v, present, err := c.host.RegistryDWORD(path, name)
	switch {
	case err != nil:
		c.addError(step, "unreadable")
		return RegUnreadable
	case !present:
		return RegAbsent
	case v == 1:
		return RegEnabled
	case v == 0:
		return RegDisabled
	}
	return RegOther
}

// winget looks for App Installer's winget.exe under WindowsApps, where SYSTEM
// would run it from. It is never run; the version is the package directory's.
func (c *collector) winget() {
	w := &c.o.Winget
	pf := c.programFiles()
	if pf == "" || c.host.ListDirs == nil || c.host.RegularFile == nil {
		c.addError("winget", "unavailable")
		return
	}
	root := pf + `\WindowsApps`
	dirs, err := c.host.ListDirs(root)
	if err != nil {
		c.addError("winget", "dir_unreadable")
		return
	}
	var best string
	for _, d := range dirs {
		m := appInstallerRe.FindStringSubmatch(d)
		if m == nil || !c.host.RegularFile(root+`\`+d+`\winget.exe`) {
			continue
		}
		if best == "" || versionLess(best, m[1]) {
			best = m[1]
		}
	}
	w.Present = new(best != "")
	if best != "" {
		w.Version = vVersion(best)
	}
}

func (c *collector) conflicts() {
	if c.host.ProgramEntries == nil {
		c.addError("conflicts", "unavailable")
		return
	}
	entries, err := c.host.ProgramEntries()
	if err != nil {
		c.addError("conflicts", "unreadable")
		return
	}
	for _, e := range entries {
		name := strings.TrimSpace(e.DisplayName)
		var kind string
		switch {
		case supportAssistantRe.MatchString(name):
			kind = "hp_support_assistant"
		case insightsRe.MatchString(name):
			kind = "hp_insights"
		default:
			continue
		}
		if slices.ContainsFunc(c.o.Conflicts, func(x Conflict) bool { return x.Name == kind }) || len(c.o.Conflicts) >= maxConflicts {
			continue
		}
		c.o.Conflicts = append(c.o.Conflicts, Conflict{Name: kind, Version: vVersion(strings.TrimSpace(e.DisplayVersion))})
	}
}

// --- bounds and text -------------------------------------------------------

// bound keeps the record within MaxBytes by dropping rows, last class first,
// then date formats, then property lists. The truncation marker is added
// BEFORE trimming, so the record with its marker fits: a record over the cap
// is stored by the API as a rejection marker only.
func bound(o *Observation) {
	if size(o) <= MaxBytes {
		return
	}
	if len(o.Errors) >= maxErrors {
		o.Errors = o.Errors[:maxErrors-1]
	}
	o.Errors = append(o.Errors, StepError{Step: "bound", Code: "truncated"})
	classes := []*ClassObservation{o.HPEntitlements, o.HPWarranty}
	for _, co := range classes {
		for co != nil && len(co.Rows) > 0 && size(o) > MaxBytes {
			co.Rows = co.Rows[:len(co.Rows)-1]
		}
	}
	for _, co := range classes {
		if co != nil && size(o) > MaxBytes {
			co.DateFormats = map[string]string{}
		}
	}
	for _, co := range classes {
		for co != nil && len(co.Properties) > 0 && size(o) > MaxBytes {
			co.Properties = co.Properties[:len(co.Properties)-1]
		}
	}
	if o.Classes != nil && size(o) > MaxBytes {
		o.Classes.Names = []string{}
	}
}

func size(o *Observation) int {
	b, err := json.Marshal(o)
	if err != nil {
		return MaxBytes + 1
	}
	return len(b)
}

func clampCount(n int) int {
	return max(0, min(n, maxCount))
}

// cleanText drops control characters and invalid UTF-8, trims, and cuts to
// max runes.
func cleanText(s string, limit int) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if r == utf8.RuneError || r < 0x20 || r == 0x7f {
			continue
		}
		if n == limit {
			break
		}
		b.WriteRune(r)
		n++
	}
	return strings.TrimSpace(b.String())
}

func optText(s string) *string {
	t := cleanText(s, maxTextLen)
	if t == "" {
		return nil
	}
	return &t
}

// vVersion is a dotted version with a v prefix, so the agent-log redactor does
// not read a four-part version as an IPv4 address; nil when s is not one.
func vVersion(s string) *string {
	if !dottedVerRe.MatchString(s) || len(s)+1 > maxVersionText {
		return nil
	}
	v := "v" + s
	return &v
}

func versionLess(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

// ErrOutputTooLarge and ErrCommandRefused are the runner's refusals.
var (
	ErrOutputTooLarge = errors.New("hpwarrantyobserve: script output too large")
	ErrCommandRefused = errors.New("hpwarrantyobserve: command is not the fixed read-only script")
)
