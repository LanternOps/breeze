package wakeconfig

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
)

// Surface observe (#10838 W09, amendment §2): Surface has no firmware
// settings, so observation confirms the readiness classifier's inputs: the
// identity, and for each wired adapter its PnP vendor and device ID, driver
// provider and description. MAC addresses are never read here.

const surfaceReadTimeout = 60 * time.Second

// Which rule decided the Surface classification.
const (
	SurfaceDecidedByVM         = "vm_rule"
	SurfaceDecidedByModel      = "surface_model"
	SurfaceDecidedByOtherModel = "other_model"
)

// surfaceReadScript is READ-ONLY: Win32_ComputerSystem's SKU and model, and
// Get-NetAdapter's PnP id, driver provider and description for physical wired
// (802.3) adapters. It reads no MAC address and calls no method.
const surfaceReadScript = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
function ErrOf($step, $e) { $n=$null; try { $n=[string]$e.Exception.NativeErrorCode } catch { $n=$null }; return [pscustomobject]@{ step=$step; fqid=[string]$e.FullyQualifiedErrorId; native=$n } }
$o=[ordered]@{ identity=$null; netAdapter=$true; adapters=@(); error=$null }
try { $c=@(Get-CimInstance -ClassName Win32_ComputerSystem -OperationTimeoutSec 10)[0]; $o.identity=[pscustomobject]@{ sku=[string]$c.SystemSKUNumber; model=[string]$c.Model } } catch { $o.error=(ErrOf 'identity' $_) }
if (-not (Get-Command -Name Get-NetAdapter -ErrorAction SilentlyContinue)) { $o.netAdapter=$false }
if ($o.netAdapter -and $null -eq $o.error) {
 try { $o.adapters=@(Get-NetAdapter -Physical | Where-Object { $_.NdisPhysicalMedium -eq 14 } | ForEach-Object { [pscustomobject]@{ pnp=[string]$_.PnPDeviceID; provider=[string]$_.DriverProvider; description=[string]$_.InterfaceDescription } }) } catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { $o.error=(ErrOf 'adapters' $_) } }
}
ConvertTo-Json -InputObject ([pscustomobject]$o) -Depth 4 -Compress`

var (
	// pnpIDRe keeps the bus and the vendor and device (or VID and PID) only.
	pnpIDRe        = regexp.MustCompile(`(?i)^(PCI)\\(VEN_[0-9A-F]{4}&DEV_[0-9A-F]{4})|^(USB)\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})`)
	surfaceMatchRe = regexp.MustCompile(`(?i)surface`)
)

type surfaceRaw struct {
	Identity *struct {
		SKU   string `json:"sku"`
		Model string `json:"model"`
	} `json:"identity"`
	NetAdapter *bool `json:"netAdapter"`
	Adapters   []struct {
		PnP         string `json:"pnp"`
		Provider    string `json:"provider"`
		Description string `json:"description"`
	} `json:"adapters"`
	Error *biosconfig.ScriptError `json:"error"`
}

func pnpID(raw string) *string {
	m := pnpIDRe.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return nil
	}
	id := strings.ToUpper(m[1] + `\` + m[2])
	if m[1] == "" {
		id = strings.ToUpper(m[3] + `\` + m[4])
	}
	return &id
}

// isSurfaceMake is the Surface lane's make rule: Microsoft hardware.
func isSurfaceMake(manufacturer string) bool {
	return biosconfig.MakeOf(manufacturer) == "microsoft"
}

func emptySurface() *biosconfig.SurfaceObservation {
	return &biosconfig.SurfaceObservation{Adapters: []biosconfig.SurfaceAdapter{}}
}

// observeSurface runs the existing VM rule first (a Hyper-V guest reports
// Microsoft Corporation), then reads identity and adapters.
func observeSurface(ctx context.Context, run biosconfig.Runner, in Inputs) *biosconfig.Observation {
	s := emptySurface()
	s.Model = biosconfig.CleanPtr(in.Model, biosconfig.MaxObservedField)
	if in.Virtual {
		s.Virtual = true
		s.VirtualPlatform = biosconfig.CleanPtr(in.VirtualPlatform, 32)
		s.DecidedBy = SurfaceDecidedByVM
		return &biosconfig.Observation{Vendor: "microsoft", Interface: biosconfig.InterfaceAbsent, Surface: s}
	}
	s.DecidedBy = SurfaceDecidedByOtherModel
	if surfaceMatchRe.MatchString(in.Model) {
		s.DecidedBy = SurfaceDecidedByModel
	}
	fail := func(iface, code string) *biosconfig.Observation {
		return &biosconfig.Observation{Vendor: "microsoft", Interface: iface, ErrorCode: &code, Surface: s}
	}
	ctx, cancel := context.WithTimeout(ctx, surfaceReadTimeout)
	defer cancel()
	out, err := run(ctx, surfaceReadScript, nil)
	if err != nil {
		return fail(biosconfig.InterfaceError, biosconfig.RunFailureCode(err))
	}
	var raw surfaceRaw
	if err := biosconfig.DecodeScript(out, &raw); err != nil {
		return fail(biosconfig.InterfaceError, "unparseable_output")
	}
	if raw.Identity != nil {
		s.SystemSKU = biosconfig.CleanPtr(raw.Identity.SKU, biosconfig.MaxObservedField)
		if m := biosconfig.CleanPtr(raw.Identity.Model, biosconfig.MaxObservedField); m != nil {
			s.Model = m
		}
	}
	for _, a := range raw.Adapters {
		if len(s.Adapters) == biosconfig.MaxSurfaceAdapters {
			s.AdaptersTruncated = true
			break
		}
		desc := biosconfig.CleanPtr(a.Description, biosconfig.MaxObservedField)
		s.Adapters = append(s.Adapters, biosconfig.SurfaceAdapter{
			PnPID:          pnpID(a.PnP),
			DriverProvider: biosconfig.CleanPtr(a.Provider, biosconfig.MaxObservedField),
			Description:    desc,
			SurfaceMatch:   desc != nil && surfaceMatchRe.MatchString(*desc),
		})
	}
	if raw.Error != nil {
		return fail(biosconfig.ClassifyScriptError(raw.Error))
	}
	if raw.NetAdapter != nil && !*raw.NetAdapter {
		return fail(biosconfig.InterfaceError, "nic_cmdlets_unavailable")
	}
	return &biosconfig.Observation{Vendor: "microsoft", Interface: biosconfig.InterfacePresent, Surface: s}
}
