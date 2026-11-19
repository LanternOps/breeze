package biosconfig

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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

// dellAdapter reads Dell BIOS settings through native WMI. Read-only in this
// release.
type dellAdapter struct {
	run func(ctx context.Context, script string) ([]byte, error)
	now func() time.Time // nil means time.Now

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

// Apply is not implemented in this release (W04) and runs nothing.
func (d *dellAdapter) Apply(ctx context.Context, name, value string) error {
	return ErrNotEnabled
}
