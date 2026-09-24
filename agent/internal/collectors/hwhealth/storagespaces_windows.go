//go:build windows

package hwhealth

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// spacesPools lists non-primordial pools. Under ErrorActionPreference=Stop,
// Get-StoragePool -IsPrimordial $false THROWS ObjectNotFound when the host has
// no pool (the common case), so only that category means "zero pools"; any
// other error still fails the probe/collection visibly.
const spacesPools = `$pools=@(); try { $pools=@(Get-StoragePool -IsPrimordial $false) } catch { if ([string]$_.CategoryInfo.Category -ne 'ObjectNotFound') { throw } }`

const spacesDetectScript = `$ErrorActionPreference='Stop'
` + spacesPools + `
$pools.Count`

const spacesScript = `$ErrorActionPreference='Stop'
` + spacesPools + `
$vds=@(); $pds=@(); $warnings=@(); $jobs=@()
try { $jobs=@(Get-StorageJob) } catch { $warnings += 'Storage job progress unavailable' }
foreach($p in $pools) {
 foreach($v in @(Get-VirtualDisk -StoragePool $p)) {
  $ids=@(Get-PhysicalDisk -VirtualDisk $v | ForEach-Object { [string]$_.UniqueId })
  $matching=@($jobs|Where-Object { $_.Name -like ('*'+$v.FriendlyName+'*') -and $_.PercentComplete -ne $null })
  $progress=$null; if($matching.Count -eq 1 -and @($pools|Get-VirtualDisk|Where-Object {$_.FriendlyName -eq $v.FriendlyName}).Count -eq 1) { $progress=[int]$matching[0].PercentComplete }
  $vds += [pscustomobject]@{ObjectId=[string]$v.ObjectId;FriendlyName=$v.FriendlyName;HealthStatus=[string]$v.HealthStatus;OperationalStatus=@($v.OperationalStatus|ForEach-Object{[string]$_});Size=$v.Size;MemberIds=$ids;Progress=$progress}
 }
 foreach($d in @(Get-PhysicalDisk -StoragePool $p)) {
  $pds += [pscustomobject]@{UniqueId=[string]$d.UniqueId;ObjectId=[string]$d.ObjectId;SerialNumber=$d.SerialNumber;FriendlyName=$d.FriendlyName;Model=$d.Model;FirmwareVersion=$d.FirmwareVersion;HealthStatus=[string]$d.HealthStatus;OperationalStatus=@($d.OperationalStatus|ForEach-Object{[string]$_});Usage=[string]$d.Usage;Size=$d.Size}
 }
}
[pscustomobject]@{Pools=@($pools|ForEach-Object{[pscustomobject]@{ObjectId=[string]$_.ObjectId;FriendlyName=$_.FriendlyName;HealthStatus=[string]$_.HealthStatus}});VirtualDisks=@($vds);PhysicalDisks=@($pds|Sort-Object UniqueId -Unique);Warnings=@($warnings)} | ConvertTo-Json -Depth 3 -Compress`

func newStorageSpaces() Source {
	return &source{
		kind: "storage_spaces",
		tier: TierRAID,
		detect: func(ctx context.Context) Availability {
			o, e := runPowerShell(ctx, 60*time.Second, spacesDetectScript)
			return Availability{Path: "powershell.exe", Available: e != nil || o.ExitCode != 0 || number(strings.TrimSpace(string(o.Stdout))) > 0}
		},
		collect: func(ctx context.Context, a Availability) (Result, error) {
			o, e := runPowerShell(ctx, 60*time.Second, spacesScript)
			if e != nil {
				return Result{}, e
			}
			if o.ExitCode != 0 {
				return Result{}, fmt.Errorf("Storage Spaces exit %d", o.ExitCode)
			}
			return parseSpaces(o.Stdout)
		},
	}
}
