//go:build windows

package hwhealth

import (
	"context"
	"fmt"
	"time"
)

const winPDScript = `$ErrorActionPreference='Stop'
$warnings=@();$disks=@()
foreach($d in @(Get-PhysicalDisk)) {
 $r=$null
 try { $r=$d | Get-StorageReliabilityCounter -ErrorAction Stop } catch { $warnings += ('Reliability counters unavailable for '+[string]$d.UniqueId) }
 $disks += [pscustomobject]@{UniqueId=[string]$d.UniqueId;ObjectId=[string]$d.ObjectId;SerialNumber=$d.SerialNumber;FriendlyName=$d.FriendlyName;Model=$d.Model;FirmwareVersion=$d.FirmwareVersion;HealthStatus=[string]$d.HealthStatus;OperationalStatus=@($d.OperationalStatus|ForEach-Object{[string]$_});Usage=[string]$d.Usage;Size=$d.Size;Temperature=$(if($r){$r.Temperature}else{$null});Wear=$(if($r){$r.Wear}else{$null});ReadErrorsTotal=$(if($r){$r.ReadErrorsTotal}else{$null});WriteErrorsTotal=$(if($r){$r.WriteErrorsTotal}else{$null})}
}
[pscustomobject]@{Disks=@($disks);Warnings=@($warnings)} | ConvertTo-Json -Depth 3 -Compress`

func newWinPD(remembered map[string]string) Source {
	return &source{
		kind: "windows_physical_disk",
		tier: TierDisk,
		detect: func(context.Context) Availability {
			return Availability{Path: "powershell.exe", Available: true}
		},
		collect: func(ctx context.Context, a Availability) (Result, error) {
			o, e := runPowerShell(ctx, 60*time.Second, winPDScript)
			if e != nil {
				return Result{}, e
			}
			if o.ExitCode != 0 {
				return Result{}, fmt.Errorf("Get-PhysicalDisk exit %d", o.ExitCode)
			}
			return parseWinPD(o.Stdout, remembered)
		},
	}
}
