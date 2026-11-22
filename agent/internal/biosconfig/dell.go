package biosconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// dellReadScript is READ-ONLY. It reads Dell's native BIOS WMI (no Dell tool
// installed): every EnumerationAttribute, and the PasswordObject password
// states. A missing namespace or class (older Dell without the interface)
// reports biosAttributes=false instead of failing; any other error fails the
// script. A password-state failure reports passwords=null (protection
// unknown). It lives in an untagged file so the parser and its read-only
// guarantee are tested on every OS, against output captured on real hardware.
//
// testdata/dell-optiplex-7060-bios-read.json is this exact script's output; if
// the script changes, re-capture it on a Dell as SYSTEM.
const dellReadScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
$iface=$true
$enum=@()
try {
 $enum=@(Get-CimInstance -Namespace 'root\dcim\sysman\biosattributes' -ClassName 'EnumerationAttribute' | ForEach-Object {
  [pscustomobject]@{ AttributeName=[string]$_.AttributeName; CurrentValue=@($_.CurrentValue | ForEach-Object { [string]$_ }); PossibleValue=@($_.PossibleValue | ForEach-Object { [string]$_ }) }
 })
} catch {
 if ([string]$_.Exception.NativeErrorCode -in @('InvalidNamespace','InvalidClass')) { $iface=$false } else { throw }
}
$pw=$null
if ($iface) {
 try {
  $pw=@(Get-CimInstance -Namespace 'root\dcim\sysman\wmisecurity' -ClassName 'PasswordObject' | ForEach-Object {
   [pscustomobject]@{ NameId=[string]$_.NameId; IsPasswordSet=[int]$_.IsPasswordSet }
  })
 } catch { $pw=$null }
}
ConvertTo-Json -InputObject ([pscustomobject]@{ biosAttributes=$iface; enumeration=$enum; passwords=$pw }) -Depth 4 -Compress`

// dellRead is one parsed run of dellReadScript.
type dellRead struct {
	Interface  bool
	Settings   []Setting
	Protection Protection
}

type rawDellRead struct {
	BIOSAttributes *bool             `json:"biosAttributes"`
	Enumeration    []rawDellEnum     `json:"enumeration"`
	Passwords      []rawDellPassword `json:"passwords"`
}

type rawDellEnum struct {
	AttributeName string          `json:"AttributeName"`
	CurrentValue  json.RawMessage `json:"CurrentValue"`
	PossibleValue json.RawMessage `json:"PossibleValue"`
}

type rawDellPassword struct {
	NameID        string `json:"NameId"`
	IsPasswordSet *int   `json:"IsPasswordSet"`
}

// stringList accepts a JSON string array or a lone string (PowerShell can
// unroll one-element arrays); anything else is empty.
func stringList(raw json.RawMessage) []string {
	var list []string
	if err := json.Unmarshal(raw, &list); err == nil {
		return list
	}
	var one string
	if err := json.Unmarshal(raw, &one); err == nil {
		return []string{one}
	}
	return nil
}

// parseDellRead turns dellReadScript's stdout into settings and protection. It
// is pure. Protection is None only when exactly one Admin row reports 0.
func parseDellRead(raw []byte) (dellRead, error) {
	raw = bytes.TrimPrefix(bytes.TrimSpace(raw), []byte("\xef\xbb\xbf"))
	var r rawDellRead
	if err := json.Unmarshal(raw, &r); err != nil {
		return dellRead{}, fmt.Errorf("parse dell bios read: %w", err)
	}
	if r.BIOSAttributes == nil {
		return dellRead{}, fmt.Errorf("parse dell bios read: biosAttributes missing")
	}
	out := dellRead{Interface: *r.BIOSAttributes, Protection: ProtectionUnknown}
	for _, e := range r.Enumeration {
		name := strings.TrimSpace(e.AttributeName)
		if name == "" {
			continue
		}
		s := Setting{Name: name, Allowed: stringList(e.PossibleValue)}
		if cur := stringList(e.CurrentValue); len(cur) > 0 {
			s.Value = cur[0]
		}
		out.Settings = append(out.Settings, s)
	}
	admins := 0
	adminSet := -1
	for _, p := range r.Passwords {
		if p.NameID == "Admin" {
			admins++
			if p.IsPasswordSet != nil {
				adminSet = *p.IsPasswordSet
			}
		}
	}
	if admins == 1 {
		switch adminSet {
		case 0:
			out.Protection = ProtectionNone
		case 1:
			out.Protection = ProtectionSet
		}
	}
	return out, nil
}

// dellApplyScript is the one firmware write in this package (W04). It sets one
// Dell BIOS enumeration attribute through native WMI, BIOSAttributeInterface
// SetAttribute, with no password (SecType 0, no handle): the caller only asks
// when the Admin password reads as not set. The name and value arrive on stdin
// as JSON and are never spliced into the script. On the machine it re-checks
// that the name is listed exactly once (case-sensitive) and that the value is
// one the model allows, so a stale read cannot push a value the BIOS does not
// list. It prints the method's Status and ReturnValue, or one of its own fixed
// refusal codes; it never prints device text.
//
// DOC-DERIVED: the class, argument names and Status codes come from Dell's
// native BIOS WMI documentation. No write has been captured on hardware; the
// Dell lab gate (plan Task 16) confirms them before anything activates it.
const dellApplyScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
$o=[ordered]@{ status=$null; returnValue=$null; error=$null }
try {
 $req=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
 $name=[string]$req.name
 $value=[string]$req.value
 if ($name -cnotmatch '^[A-Za-z0-9]{1,64}$' -or $value -cnotmatch '^[A-Za-z0-9]{1,64}$') { $o.error='bad_request' }
 else {
  $attr=@(Get-CimInstance -Namespace 'root\dcim\sysman\biosattributes' -ClassName 'EnumerationAttribute' | Where-Object { [string]$_.AttributeName -ceq $name })
  if ($attr.Count -ne 1) { $o.error='not_listed' }
  elseif (-not (@($attr[0].PossibleValue | ForEach-Object { [string]$_ }) -ccontains $value)) { $o.error='value_not_allowed' }
  else {
   $bai=@(Get-CimInstance -Namespace 'root\dcim\sysman\biosattributes' -ClassName 'BIOSAttributeInterface')
   if ($bai.Count -ne 1) { $o.error='no_interface' }
   else {
    $r=Invoke-CimMethod -InputObject $bai[0] -MethodName SetAttribute -Arguments @{ SecType=[uint32]0; SecHndCount=[uint32]0; SecHandle=[byte[]]@(); AttributeName=$name; AttributeValue=$value }
    if ($null -ne $r.Status) { $o.status=[int64]$r.Status }
    if ($null -ne $r.ReturnValue) { $o.returnValue=[int64]$r.ReturnValue }
   }
  }
 }
} catch { $o.error='exception' }
ConvertTo-Json -InputObject ([pscustomobject]$o) -Compress`

// ErrApplyFailed wraps every failed firmware write: the script did not run,
// refused, or did not report a clean success.
var ErrApplyFailed = errors.New("firmware setting write failed")

// DellStatusError is a SetAttribute Status other than 0.
type DellStatusError struct{ Code int }

var dellStatusText = map[int]string{
	1: "failed", 2: "invalid parameter", 3: "access denied", 4: "not supported", 5: "memory error", 6: "protocol error",
}

func (e *DellStatusError) Error() string {
	if t, ok := dellStatusText[e.Code]; ok {
		return fmt.Sprintf("dell SetAttribute status %d (%s)", e.Code, t)
	}
	return fmt.Sprintf("dell SetAttribute status %d (unrecognised)", e.Code)
}

func (e *DellStatusError) Unwrap() error { return ErrApplyFailed }

// dellToken is the only shape a name or value may have on its way to the
// write script: a plain identifier, as every Dell enumeration name and value
// in the capture is.
var dellToken = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)

// dellRefusalCode matches the script's own fixed refusal codes.
var dellRefusalCode = regexp.MustCompile(`^[a-z_]{1,32}$`)

// parseDellApply accepts only a clean success: the script's exact three keys,
// no refusal, at least one of Status and ReturnValue present, and every one
// present a bare JSON integer 0. It is pure, and never repeats the output in
// an error.
func parseDellApply(raw []byte) error {
	raw = bytes.TrimPrefix(bytes.TrimSpace(raw), []byte("\xef\xbb\xbf"))
	var r map[string]json.RawMessage
	if err := json.Unmarshal(raw, &r); err != nil || r == nil {
		return fmt.Errorf("%w: unreadable result", ErrApplyFailed)
	}
	for _, k := range []string{"status", "returnValue", "error"} {
		if _, ok := r[k]; !ok {
			return fmt.Errorf("%w: result lacks %s", ErrApplyFailed, k)
		}
	}
	isNull := func(m json.RawMessage) bool { return string(bytes.TrimSpace(m)) == "null" }
	if !isNull(r["error"]) {
		code := "unrecognised"
		var s string
		if json.Unmarshal(r["error"], &s) == nil && dellRefusalCode.MatchString(s) {
			code = s
		}
		return fmt.Errorf("%w: write script refused: %s", ErrApplyFailed, code)
	}
	if isNull(r["status"]) && isNull(r["returnValue"]) {
		return fmt.Errorf("%w: no status reported", ErrApplyFailed)
	}
	for _, k := range []string{"status", "returnValue"} {
		if isNull(r[k]) {
			continue
		}
		v, err := strconv.ParseInt(string(bytes.TrimSpace(r[k])), 10, 64)
		if err != nil {
			return fmt.Errorf("%w: %s is not an integer", ErrApplyFailed, k)
		}
		if v != 0 {
			if v > 0 && v < 1<<31 {
				return &DellStatusError{Code: int(v)}
			}
			return fmt.Errorf("%w: status out of range", ErrApplyFailed)
		}
	}
	return nil
}

// dellAdapter reads Dell BIOS settings through native WMI and, on Windows,
// writes one enumeration attribute at a time (Apply). It holds no WOL logic:
// the caller decides which name and value to write.
type dellAdapter struct {
	run func(ctx context.Context, script string) ([]byte, error)
	// write runs dellApplyScript with stdin. nil (every OS but Windows) means
	// Apply refuses with ErrNotEnabled.
	write func(ctx context.Context, script string, stdin []byte) ([]byte, error)
	now   func() time.Time // nil means time.Now

	mu     sync.Mutex
	last   dellRead
	lastAt time.Time
}

// dellReadReuse lets Protection reuse the Read just done in the same
// collection (one PowerShell run, one consistent snapshot). Only a successful
// read is reused.
const dellReadReuse = 30 * time.Second

func (d *dellAdapter) Vendor() string { return "dell" }

func (d *dellAdapter) clock() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now()
}

func (d *dellAdapter) query(ctx context.Context) (dellRead, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if !d.lastAt.IsZero() {
		if age := d.clock().Sub(d.lastAt); age >= 0 && age < dellReadReuse {
			return d.last, nil
		}
	}
	out, err := d.run(ctx, dellReadScript)
	if err != nil {
		return dellRead{}, err
	}
	r, err := parseDellRead(out)
	if err != nil {
		return dellRead{}, err
	}
	if !r.Interface {
		return r, ErrInterfaceUnavailable
	}
	d.last, d.lastAt = r, d.clock()
	return r, nil
}

// Read returns every enumeration setting the BIOS reports.
func (d *dellAdapter) Read(ctx context.Context) ([]Setting, error) {
	r, err := d.query(ctx)
	if err != nil {
		return nil, err
	}
	return r.Settings, nil
}

// Protection reports the BIOS Admin (setup) password state. Any failure is
// ProtectionUnknown.
func (d *dellAdapter) Protection(ctx context.Context) (Protection, error) {
	r, err := d.query(ctx)
	if err != nil {
		return ProtectionUnknown, err
	}
	return r.Protection, nil
}

// forget drops the cached read, so the next Read or Protection runs fresh.
func (d *dellAdapter) forget() {
	d.mu.Lock()
	d.last, d.lastAt = dellRead{}, time.Time{}
	d.mu.Unlock()
}

// Apply sets one enumeration attribute. Only a clean status 0 is success. The
// cached read is dropped before and after, so a read-back always runs fresh,
// whether or not the write reported success (a killed write may still land).
// The caller owns every precondition (password state, BitLocker, the target
// list); this only refuses names and values that are not plain identifiers.
func (d *dellAdapter) Apply(ctx context.Context, name, value string) error {
	if d.write == nil {
		return ErrNotEnabled
	}
	if !dellToken.MatchString(name) || !dellToken.MatchString(value) {
		return fmt.Errorf("%w: name or value is not a plain identifier", ErrApplyFailed)
	}
	stdin, err := asciiJSON(map[string]string{"name": name, "value": value})
	if err != nil {
		return fmt.Errorf("%w: encode request: %v", ErrApplyFailed, err)
	}
	d.forget()
	defer d.forget()
	out, err := d.write(ctx, dellApplyScript, stdin)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrApplyFailed, err)
	}
	return parseDellApply(out)
}
