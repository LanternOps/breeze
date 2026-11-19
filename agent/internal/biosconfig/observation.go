package biosconfig

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

// Observation is details.vendorObservation in the readiness snapshot
// (amendment §2). Every field is bounded here and again by the server's strict
// schema (packages/shared/src/validators/wakeStatus.ts). It never carries a
// serial, UUID, asset or ownership tag, host or user name, or MAC address, and
// only allowlisted setting names with their values.
type Observation struct {
	Schema        int     `json:"schema"`
	Vendor        string  `json:"vendor"` // hp | lenovo | microsoft
	NativeArch    string  `json:"nativeArch"`
	Interface     string  `json:"interface"`
	ErrorCode     *string `json:"errorCode"`
	DurationMs    int64   `json:"durationMs"`
	CollectedWith string  `json:"collectedWith"`

	HP      *HPObservation      `json:"hp,omitempty"`
	Lenovo  *LenovoObservation  `json:"lenovo,omitempty"`
	Surface *SurfaceObservation `json:"surface,omitempty"`
}

// Interface values.
const (
	InterfacePresent      = "present"
	InterfaceAbsent       = "absent"
	InterfaceAccessDenied = "access_denied"
	InterfaceError        = "error"
)

// ObservedSetting is one allowlisted firmware setting.
type ObservedSetting struct {
	Name           string   `json:"name"`
	Value          string   `json:"value"`
	PossibleValues []string `json:"possibleValues"`
}

// HPObservation is what the HP adapter read from root\HP\InstrumentedBIOS.
type HPObservation struct {
	Settings           []ObservedSetting `json:"settings"`
	SettingCount       int               `json:"settingCount"`
	Truncated          bool              `json:"truncated"`
	SetupPasswordSet   *bool             `json:"setupPasswordSet"`
	PowerOnPasswordSet *bool             `json:"powerOnPasswordSet"`
	SureAdmin          *string           `json:"sureAdmin"`
	SettingInterface   *bool             `json:"settingInterface"`
}

// LenovoObservation is what the Lenovo adapter read from root\wmi.
type LenovoObservation struct {
	Settings        []ObservedSetting `json:"settings"`
	SettingCount    int               `json:"settingCount"`
	Truncated       bool              `json:"truncated"`
	PasswordState   *int              `json:"passwordState"`
	Classes         []string          `json:"classes"`
	MachineType     *string           `json:"machineType"`
	SelectionCalls  int               `json:"selectionCalls"`
	SelectionErrors int               `json:"selectionErrors"`
}

// SurfaceObservation confirms the Surface readiness classifier's inputs; it is
// filled by wakeconfig (Surface has no firmware settings).
type SurfaceObservation struct {
	SystemSKU         *string          `json:"systemSku"`
	Model             *string          `json:"model"`
	Virtual           bool             `json:"virtual"`
	VirtualPlatform   *string          `json:"virtualPlatform"`
	DecidedBy         string           `json:"decidedBy"`
	Adapters          []SurfaceAdapter `json:"adapters"`
	AdaptersTruncated bool             `json:"adaptersTruncated"`
}

// SurfaceAdapter is one wired adapter, identified by its PnP vendor and device
// ID only (never the instance part, which can carry a serial).
type SurfaceAdapter struct {
	PnPID          *string `json:"pnpId"`
	DriverProvider *string `json:"driverProvider"`
	Description    *string `json:"description"`
	SurfaceMatch   bool    `json:"surfaceMatch"`
}

// Bounds (amendment §2), mirrored by the server schema.
const (
	MaxObservedSettings = 48
	MaxObservedField    = 64
	MaxPossibleValues   = 16
	MaxSettingsBytes    = 8 << 10
	MaxClasses          = 64
	MaxSelectionCalls   = 48
	MaxSurfaceAdapters  = 16
)

// The setting-name rule, deny first (amendment §2).
var (
	denyNameRe  = regexp.MustCompile(`(?i)asset|owner|serial|uuid|tag|password|pin|key|cert|user|email|phone|name of|location`)
	allowNameRe = regexp.MustCompile(`(?i)wake|wol|\blan\b|s4|s5|deep ?sleep|power ?sav|after power|ac (recovery|power)|erp|network boot|pxe`)
	macRe       = regexp.MustCompile(`(?i)\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b|\b[0-9a-f]{12}\b`)
	errorCodeRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,64}$`)
	hresultRe   = regexp.MustCompile(`(?i)\bHRESULT 0x([0-9a-f]{8})\b`)
)

// allowedSettingName applies the deny-then-allow rule to a cleaned name.
func allowedSettingName(name string) bool {
	if name == "" || denyNameRe.MatchString(name) {
		return false
	}
	return allowNameRe.MatchString(name)
}

// cleanText drops invalid UTF-8, control and format characters (zero-width,
// bidi overrides) and anything shaped like a MAC address, trims, and cuts to
// max runes.
func cleanText(s string, max int) string {
	s = strings.ToValidUTF8(s, "")
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(macRe.ReplaceAllString(s, ""))
	if utf8.RuneCountInString(s) > max {
		s = strings.TrimSpace(string([]rune(s)[:max]))
	}
	return s
}

func cleanPtr(s string, max int) *string {
	if c := cleanText(s, max); c != "" {
		return &c
	}
	return nil
}

// cleanValues cleans a possible-value list, dropping empties and duplicates,
// capped at MaxPossibleValues. It never returns nil.
func cleanValues(in []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, v := range in {
		c := cleanText(v, MaxObservedField)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
		if len(out) == MaxPossibleValues {
			break
		}
	}
	return out
}

// settingBuilder keeps allowlisted settings within the count and byte bounds.
type settingBuilder struct {
	out       []ObservedSetting
	seen      map[string]bool
	bytes     int
	truncated bool
}

func newSettingBuilder() *settingBuilder {
	return &settingBuilder{out: []ObservedSetting{}, seen: map[string]bool{}, bytes: 2}
}

// add keeps the setting if its name is allowlisted and it fits; it reports
// whether it was kept.
func (b *settingBuilder) add(rawName, rawValue string, possible []string) bool {
	name := cleanText(rawName, MaxObservedField)
	if !allowedSettingName(name) || b.seen[name] {
		return false
	}
	if len(b.out) == MaxObservedSettings {
		b.truncated = true
		return false
	}
	s := ObservedSetting{Name: name, Value: cleanText(rawValue, MaxObservedField), PossibleValues: cleanValues(possible)}
	enc, err := json.Marshal(s)
	if err != nil {
		return false
	}
	if b.bytes+len(enc)+1 > MaxSettingsBytes {
		b.truncated = true
		return false
	}
	b.bytes += len(enc) + 1
	b.seen[name] = true
	b.out = append(b.out, s)
	return true
}

// fitSettingsBytes drops settings from the end until the list encodes within
// MaxSettingsBytes; it reports whether any were dropped.
func fitSettingsBytes(in []ObservedSetting) ([]ObservedSetting, bool) {
	for n := len(in); n >= 0; n-- {
		enc, err := json.Marshal(in[:n])
		if err == nil && len(enc) <= MaxSettingsBytes {
			return in[:n], n < len(in)
		}
	}
	return []ObservedSetting{}, len(in) > 0
}

// scriptError is the error block a read script emits for a failed CIM call.
type scriptError struct {
	Step   string `json:"step"`
	FQID   string `json:"fqid"`
	Native string `json:"native"`
}

// WMI HRESULTs the classification names.
const (
	wbemNotFound         = "0x80041002"
	wbemAccessDenied     = "0x80041003"
	wbemInvalidNamespace = "0x8004100E"
	wbemInvalidClass     = "0x80041010"
	eAccessDenied        = "0x80070005"
)

var nativeCodes = map[string]string{
	"InvalidNamespace": wbemInvalidNamespace,
	"InvalidClass":     wbemInvalidClass,
	"AccessDenied":     wbemAccessDenied,
	"NotFound":         wbemNotFound,
}

// classifyScriptError maps a CIM failure to the interface state and an
// identifier code: the HRESULT out of the fully qualified error id when there
// is one, else the CIM native error name. Free text never becomes the code.
func classifyScriptError(e *scriptError) (iface, code string) {
	code = "unknown"
	if m := hresultRe.FindStringSubmatch(e.FQID); m != nil {
		code = "0x" + strings.ToUpper(m[1])
	} else if c, ok := nativeCodes[e.Native]; ok {
		code = c
	} else if errorCodeRe.MatchString(e.Native) {
		code = e.Native
	}
	switch code {
	case wbemInvalidNamespace, wbemInvalidClass, wbemNotFound:
		return InterfaceAbsent, code
	case wbemAccessDenied, eAccessDenied:
		return InterfaceAccessDenied, code
	}
	return InterfaceError, code
}

// runFailureCode names a runner failure without carrying its text.
func runFailureCode(err error) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, ErrUnsupported):
		return "unsupported"
	}
	return "script_failed"
}

// ErrUnsupported is the runner's answer off Windows.
var ErrUnsupported = errors.New("firmware observation is only supported on Windows")

// decodeScript parses a read script's stdout, tolerating a UTF-8 BOM.
func decodeScript(out []byte, v any) error {
	out = []byte(strings.TrimSpace(strings.TrimPrefix(string(out), "\xef\xbb\xbf")))
	if len(out) == 0 {
		return errors.New("empty output")
	}
	if err := json.Unmarshal(out, v); err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	return nil
}

// failed builds an observation for a failure before anything was read.
func failed(vendor, iface, code string) *Observation {
	return &Observation{Vendor: vendor, Interface: iface, ErrorCode: &code}
}

// Failed is an error observation for vendor ("hp", "lenovo" or "microsoft")
// with its empty vendor block, for a caller that could not run the read at all
// (a panic). It returns nil for any other vendor.
func Failed(vendor, code string) *Observation {
	if !errorCodeRe.MatchString(code) {
		code = "unknown"
	}
	o := failed(vendor, InterfaceError, code)
	switch vendor {
	case "hp":
		o.HP = emptyHP()
	case "lenovo":
		o.Lenovo = emptyLenovo()
	case "microsoft":
		o.Surface = &SurfaceObservation{Adapters: []SurfaceAdapter{}, DecidedBy: "error"}
	default:
		return nil
	}
	return o
}

// ClassifyScriptError and friends are the shared pieces wakeconfig's Surface
// read uses, so both packages map failures and clean text the same way.

// ScriptError is the error block every read script emits.
type ScriptError = scriptError

// ClassifyScriptError is classifyScriptError for other packages.
func ClassifyScriptError(e *ScriptError) (iface, code string) { return classifyScriptError(e) }

// RunFailureCode is runFailureCode for other packages.
func RunFailureCode(err error) string { return runFailureCode(err) }

// CleanText is cleanText for other packages.
func CleanText(s string, max int) string { return cleanText(s, max) }

// CleanPtr is cleanPtr for other packages.
func CleanPtr(s string, max int) *string { return cleanPtr(s, max) }

// DecodeScript is decodeScript for other packages.
func DecodeScript(out []byte, v any) error { return decodeScript(out, v) }

// scriptWriteVerbs are PowerShell verbs and forms no read script may carry.
var scriptWriteVerbs = []string{"Set-", "New-", "Remove-", "Clear-", "Rename-", "Enable-", "Disable-", "Start-", "Stop-", "Restart-", "Invoke-Expression", "iex ", "Add-Type"}

// WriteVerbIn returns the first write verb found in a read script, or "".
// Tests in this package and in wakeconfig run it on every constant script.
func WriteVerbIn(script string) string {
	for _, v := range scriptWriteVerbs {
		if strings.Contains(script, v) {
			return v
		}
	}
	return ""
}

// asciiJSON marshals v with every non-ASCII rune as a \uXXXX escape, so a
// script decodes it the same whatever the console's input code page.
func asciiJSON(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var b strings.Builder
	for _, r := range string(raw) {
		switch {
		case r < 0x80:
			b.WriteRune(r)
		case r > 0xFFFF:
			hi, lo := utf16.EncodeRune(r)
			fmt.Fprintf(&b, `\u%04x\u%04x`, hi, lo)
		default:
			fmt.Fprintf(&b, `\u%04x`, r)
		}
	}
	return []byte(b.String()), nil
}

// ValidErrorCode reports whether code is an identifier the schema accepts.
func ValidErrorCode(code string) bool { return errorCodeRe.MatchString(code) }
