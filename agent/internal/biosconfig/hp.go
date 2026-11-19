package biosconfig

import (
	"context"
	"strings"
	"time"
)

// hpReadTimeout bounds the whole HP read; each CIM call inside it carries its
// own -OperationTimeoutSec.
const hpReadTimeout = 60 * time.Second

// hpReadScript reads root\HP\InstrumentedBIOS: every HP_BIOSEnumeration
// setting (name, current value, possible values), HP_BIOSPassword's IsSet, and
// whether the setting interface class exists. It never calls a method; values
// are filtered in Go (allowedSettingName) before anything leaves the agent.
const hpReadScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
function ErrOf($step, $e) { $n=$null; try { $n=[string]$e.Exception.NativeErrorCode } catch { $n=$null }; return [pscustomobject]@{ step=$step; fqid=[string]$e.FullyQualifiedErrorId; native=$n } }
$ns='root\HP\InstrumentedBIOS'
$o=[ordered]@{ enum=@(); passwords=@(); settingInterface=$null; error=$null }
try {
 $o.enum=@(Get-CimInstance -Namespace $ns -ClassName HP_BIOSEnumeration -OperationTimeoutSec 20 | ForEach-Object {
  $pv=@(); if ($null -ne $_.PossibleValues) { $pv=@(foreach ($p in $_.PossibleValues) { [string]$p }) }
  [pscustomobject]@{ name=[string]$_.Name; value=[string]$_.CurrentValue; possible=$pv }
 })
} catch { $o.error=(ErrOf 'enum' $_) }
if ($null -eq $o.error) {
 try { $o.passwords=@(Get-CimInstance -Namespace $ns -ClassName HP_BIOSPassword -OperationTimeoutSec 10 | ForEach-Object { [pscustomobject]@{ name=[string]$_.Name; isSet=[int]$_.IsSet } }) } catch { $o.passwords=$null }
 try { $o.settingInterface=($null -ne (Get-CimClass -Namespace $ns -ClassName HP_BIOSSettingInterface -OperationTimeoutSec 10)) } catch { $o.settingInterface=$false }
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 5 -Compress`

const (
	hpSetupPassword   = "setup password"
	hpPowerOnPassword = "power-on password"
	// hpSureAdmin is the Sure Admin (Enhanced BIOS Authentication Mode) name.
	hpSureAdmin = "enhanced bios authentication mode"
)

type hpRaw struct {
	Enum []struct {
		Name     string   `json:"name"`
		Value    string   `json:"value"`
		Possible []string `json:"possible"`
	} `json:"enum"`
	// Passwords is null when HP_BIOSPassword could not be read.
	Passwords *[]struct {
		Name  string `json:"name"`
		IsSet any    `json:"isSet"`
	} `json:"passwords"`
	SettingInterface *bool        `json:"settingInterface"`
	Error            *scriptError `json:"error"`
}

type hpAdapter struct {
	run Runner
}

func (a *hpAdapter) Vendor() string { return "hp" }

// Apply is not enabled at the observe stage.
func (a *hpAdapter) Apply(context.Context, string, string) error { return ErrNotEnabled }

func (a *hpAdapter) Read(ctx context.Context) ([]Setting, error) {
	return observedSettings(a.Observe(ctx), func(o *Observation) []ObservedSetting { return o.HP.Settings })
}

// Protection is Set when the setup password or Sure Admin is on, None only
// when both are positively off, and Unknown otherwise.
func (a *hpAdapter) Protection(ctx context.Context) (Protection, error) {
	o := a.Observe(ctx)
	if o.Interface != InterfacePresent || o.HP == nil {
		return ProtectionUnknown, nil
	}
	h := o.HP
	if (h.SetupPasswordSet != nil && *h.SetupPasswordSet) || (h.SureAdmin != nil && strings.EqualFold(*h.SureAdmin, "enable")) {
		return ProtectionSet, nil
	}
	if h.SetupPasswordSet != nil && (h.SureAdmin == nil || strings.EqualFold(*h.SureAdmin, "disable")) {
		return ProtectionNone, nil
	}
	return ProtectionUnknown, nil
}

func emptyHP() *HPObservation { return &HPObservation{Settings: []ObservedSetting{}} }

func (a *hpAdapter) Observe(ctx context.Context) *Observation {
	ctx, cancel := context.WithTimeout(ctx, hpReadTimeout)
	defer cancel()
	out, err := a.run(ctx, hpReadScript, nil)
	if err != nil {
		o := failed("hp", InterfaceError, runFailureCode(err))
		o.HP = emptyHP()
		return o
	}
	var raw hpRaw
	if err := decodeScript(out, &raw); err != nil {
		o := failed("hp", InterfaceError, "unparseable_output")
		o.HP = emptyHP()
		return o
	}
	if raw.Error != nil {
		iface, code := classifyScriptError(raw.Error)
		o := failed("hp", iface, code)
		o.HP = emptyHP()
		return o
	}
	if len(raw.Enum) == 0 {
		o := failed("hp", InterfaceAbsent, "no_instances")
		o.HP = emptyHP()
		return o
	}
	h := emptyHP()
	h.SettingCount = len(raw.Enum)
	b := newSettingBuilder()
	for _, e := range raw.Enum {
		// Sure Admin is read by its exact name, outside the allowlist.
		if strings.EqualFold(strings.TrimSpace(e.Name), hpSureAdmin) {
			h.SureAdmin = cleanPtr(e.Value, MaxObservedField)
			continue
		}
		b.add(e.Name, e.Value, e.Possible)
	}
	h.Settings, h.Truncated = b.out, b.truncated
	if raw.Passwords != nil {
		for _, p := range *raw.Passwords {
			set := isSetOf(p.IsSet)
			switch strings.ToLower(strings.TrimSpace(p.Name)) {
			case hpSetupPassword:
				h.SetupPasswordSet = set
			case hpPowerOnPassword:
				h.PowerOnPasswordSet = set
			}
		}
	}
	h.SettingInterface = raw.SettingInterface
	return &Observation{Vendor: "hp", Interface: InterfacePresent, HP: h}
}

// isSetOf reads HP_BIOSPassword.IsSet: 1 is set, 0 is not, anything else
// unknown.
func isSetOf(v any) *bool {
	switch n := v.(type) {
	case float64:
		switch n {
		case 1:
			return ptr(true)
		case 0:
			return ptr(false)
		}
	}
	return nil
}

// observedSettings turns an observation into Settings for Read; an
// observation that did not read the interface is an error.
func observedSettings(o *Observation, pick func(*Observation) []ObservedSetting) ([]Setting, error) {
	if o.Interface != InterfacePresent {
		code := ""
		if o.ErrorCode != nil {
			code = *o.ErrorCode
		}
		return nil, &readError{iface: o.Interface, code: code}
	}
	src := pick(o)
	out := make([]Setting, 0, len(src))
	for _, s := range src {
		out = append(out, Setting{Name: s.Name, Value: s.Value, Allowed: append([]string(nil), s.PossibleValues...)})
	}
	return out, nil
}

type readError struct{ iface, code string }

func (e *readError) Error() string { return "firmware interface " + e.iface + " (" + e.code + ")" }
