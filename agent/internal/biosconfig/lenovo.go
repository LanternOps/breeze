package biosconfig

import (
	"context"
	"math"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	lenovoReadTimeout = 60 * time.Second
	// Each GetBiosSelections call carries a 2 s -OperationTimeoutSec; the
	// whole batch is bounded by this.
	lenovoSelectionsTimeout = 2*time.Second*MaxSelectionCalls + 15*time.Second
	lenovoSelectionsClass   = "Lenovo_GetBiosSelections"
)

// lenovoReadScript reads root\wmi: every Lenovo_BiosSetting.CurrentSetting
// string, Lenovo_BiosPasswordSettings.PasswordState, and the names of the
// Lenovo_* classes present. It calls no method; values are filtered in Go.
const lenovoReadScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
function ErrOf($step, $e) { $n=$null; try { $n=[string]$e.Exception.NativeErrorCode } catch { $n=$null }; return [pscustomobject]@{ step=$step; fqid=[string]$e.FullyQualifiedErrorId; native=$n } }
$ns='root\wmi'
$o=[ordered]@{ settings=@(); passwordState=$null; classes=@(); error=$null }
try { $o.settings=@(Get-CimInstance -Namespace $ns -ClassName Lenovo_BiosSetting -OperationTimeoutSec 20 | ForEach-Object { [string]$_.CurrentSetting }) } catch { $o.error=(ErrOf 'settings' $_) }
if ($null -eq $o.error) {
 try { $p=@(Get-CimInstance -Namespace $ns -ClassName Lenovo_BiosPasswordSettings -OperationTimeoutSec 10); if ($p.Count -gt 0) { $o.passwordState=$p[0].PasswordState } } catch { $o.passwordState=$null }
 try { $o.classes=@(Get-CimClass -Namespace $ns -ClassName 'Lenovo_*' -OperationTimeoutSec 10 | ForEach-Object { [string]$_.CimClassName }) } catch { $o.classes=@() }
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 4 -Compress`

// lenovoSelectionsScript calls the read-only GetBiosSelections method, which
// returns the allowed values for one setting name. The names arrive as JSON
// on stdin, never in the script text; Go sends only allowlisted names.
const lenovoSelectionsScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
function ErrOf($step, $e) { $n=$null; try { $n=[string]$e.Exception.NativeErrorCode } catch { $n=$null }; return [pscustomobject]@{ step=$step; fqid=[string]$e.FullyQualifiedErrorId; native=$n } }
$req=ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$names=@(foreach ($x in $req.names) { [string]$x })
$o=[ordered]@{ received=$names.Count; results=@(); error=$null }
try {
 $inst=@(Get-CimInstance -Namespace 'root\wmi' -ClassName Lenovo_GetBiosSelections -OperationTimeoutSec 2)
 if ($inst.Count -eq 0) { throw 'no_instances' }
 $o.results=@(foreach ($n in $names) {
  try {
   $r=Invoke-CimMethod -InputObject $inst[0] -MethodName GetBiosSelections -Arguments @{ Item=$n } -OperationTimeoutSec 2
   [pscustomobject]@{ name=$n; selections=[string]$r.Selections; error=$null }
  } catch { [pscustomobject]@{ name=$n; selections=$null; error=(ErrOf 'select' $_) } }
 })
} catch { $o.error=(ErrOf 'instance' $_) }
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 4 -Compress`

var (
	lenovoClassRe       = regexp.MustCompile(`^Lenovo_[A-Za-z0-9_]{1,57}$`)
	lenovoMachineTypeRe = regexp.MustCompile(`^[0-9][A-Za-z0-9]{3}`)
)

type lenovoRaw struct {
	Settings      []string     `json:"settings"`
	PasswordState any          `json:"passwordState"`
	Classes       []string     `json:"classes"`
	Error         *scriptError `json:"error"`
}

type lenovoSelectionsRaw struct {
	Received int `json:"received"`
	Results  []struct {
		Name       string       `json:"name"`
		Selections *string      `json:"selections"`
		Error      *scriptError `json:"error"`
	} `json:"results"`
	Error *scriptError `json:"error"`
}

type lenovoAdapter struct {
	run   Runner
	model string
}

func (a *lenovoAdapter) Vendor() string { return "lenovo" }

// Apply is not enabled at the observe stage.
func (a *lenovoAdapter) Apply(context.Context, string, string) error { return ErrNotEnabled }

func (a *lenovoAdapter) Read(ctx context.Context) ([]Setting, error) {
	return observedSettings(a.Observe(ctx), func(o *Observation) []ObservedSetting { return o.Lenovo.Settings })
}

// Protection is Unknown at the observe stage. Which PasswordState bits and
// which certificate class mean "protected" is what observation settles
// (amendment §2: the certificate class is not confirmed), so no answer here
// is None.
func (a *lenovoAdapter) Protection(ctx context.Context) (Protection, error) {
	o := a.Observe(ctx)
	if o.Interface == InterfacePresent && o.Lenovo != nil && o.Lenovo.PasswordState != nil && *o.Lenovo.PasswordState != 0 {
		return ProtectionSet, nil
	}
	return ProtectionUnknown, nil
}

func emptyLenovo() *LenovoObservation {
	return &LenovoObservation{Settings: []ObservedSetting{}, Classes: []string{}}
}

// splitLenovoSetting splits a CurrentSetting string, `Name,Value` optionally
// followed by `;[Optional:a,b,c]` and further bracketed blocks.
func splitLenovoSetting(s string) (name, value string, optional []string, ok bool) {
	head, tail, _ := strings.Cut(s, ";")
	name, value, found := strings.Cut(head, ",")
	name = strings.TrimSpace(name)
	if !found || name == "" {
		return "", "", nil, false
	}
	if _, rest, ok := strings.Cut(tail, "[Optional:"); ok {
		if list, _, ok := strings.Cut(rest, "]"); ok {
			for v := range strings.SplitSeq(list, ",") {
				if v = strings.TrimSpace(v); v != "" {
					optional = append(optional, v)
				}
			}
		}
	}
	return name, strings.TrimSpace(value), optional, true
}

// lenovoMachineType is the first four characters of the SMBIOS model (the
// machine type, such as 20U9), a model code and never a serial.
func lenovoMachineType(model string) *string {
	m := strings.TrimSpace(model)
	if !lenovoMachineTypeRe.MatchString(m) {
		return nil
	}
	return new(strings.ToUpper(m[:4]))
}

// passwordStateOf accepts only an integer in uint16 range.
func passwordStateOf(v any) *int {
	f, ok := v.(float64)
	if !ok || f < 0 || f > math.MaxUint16 || f != math.Trunc(f) {
		return nil
	}
	return new(int(f))
}

// lenovoClasses keeps well-formed Lenovo_* names, sorted, unique, capped.
func lenovoClasses(in []string) []string {
	out := []string{}
	for _, c := range in {
		if lenovoClassRe.MatchString(c) && !slices.Contains(out, c) {
			out = append(out, c)
		}
	}
	slices.Sort(out)
	if len(out) > MaxClasses {
		out = out[:MaxClasses]
	}
	return out
}

func (a *lenovoAdapter) Observe(ctx context.Context) *Observation {
	readCtx, cancel := context.WithTimeout(ctx, lenovoReadTimeout)
	out, err := a.run(readCtx, lenovoReadScript, nil)
	cancel()
	fail := func(iface, code string) *Observation {
		o := failed("lenovo", iface, code)
		o.Lenovo = emptyLenovo()
		o.Lenovo.MachineType = lenovoMachineType(a.model)
		return o
	}
	if err != nil {
		return fail(InterfaceError, runFailureCode(err))
	}
	var raw lenovoRaw
	if err := decodeScript(out, &raw); err != nil {
		return fail(InterfaceError, "unparseable_output")
	}
	if raw.Error != nil {
		return fail(classifyScriptError(raw.Error))
	}
	l := emptyLenovo()
	l.MachineType = lenovoMachineType(a.model)
	l.PasswordState = passwordStateOf(raw.PasswordState)
	l.Classes = lenovoClasses(raw.Classes)
	b := newSettingBuilder()
	for _, s := range raw.Settings {
		name, value, opt, ok := splitLenovoSetting(s)
		if !ok {
			continue
		}
		l.SettingCount++
		b.add(name, value, opt)
	}
	if l.SettingCount == 0 {
		return fail(InterfaceAbsent, "no_instances")
	}
	l.Settings, l.Truncated = b.out, b.truncated
	if slices.Contains(l.Classes, lenovoSelectionsClass) && len(l.Settings) > 0 {
		a.selections(ctx, l)
	}
	return &Observation{Vendor: "lenovo", Interface: InterfacePresent, Lenovo: l}
}

// selections fills possible values from GetBiosSelections for the kept
// (allowlisted) settings only. A failed call keeps the optional list the
// setting carried and is counted.
func (a *lenovoAdapter) selections(ctx context.Context, l *LenovoObservation) {
	names := make([]string, 0, min(len(l.Settings), MaxSelectionCalls))
	for _, s := range l.Settings {
		if len(names) == MaxSelectionCalls {
			l.Truncated = true
			break
		}
		names = append(names, s.Name)
	}
	stdin, err := asciiJSON(map[string][]string{"names": names})
	if err != nil {
		return
	}
	l.SelectionCalls = len(names)
	ctx, cancel := context.WithTimeout(ctx, lenovoSelectionsTimeout)
	defer cancel()
	out, err := a.run(ctx, lenovoSelectionsScript, stdin)
	var raw lenovoSelectionsRaw
	if err != nil || decodeScript(out, &raw) != nil || raw.Error != nil {
		l.SelectionErrors = len(names)
		return
	}
	asked := map[string]bool{}
	for _, n := range names {
		asked[n] = true
	}
	got := map[string][]string{}
	for _, r := range raw.Results {
		if !asked[r.Name] {
			continue // a reply for a name that was not asked for is ignored
		}
		if r.Error != nil || r.Selections == nil {
			continue
		}
		if vals := cleanValues(strings.Split(*r.Selections, ",")); len(vals) > 0 {
			got[r.Name] = vals
		}
	}
	for i := range l.Settings {
		if !asked[l.Settings[i].Name] {
			continue
		}
		if vals, ok := got[l.Settings[i].Name]; ok {
			l.Settings[i].PossibleValues = vals
		} else {
			l.SelectionErrors++
		}
	}
	// Longer value lists can push the block past its byte bound again.
	var cut bool
	if l.Settings, cut = fitSettingsBytes(l.Settings); cut {
		l.Truncated = true
	}
}
