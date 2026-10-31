package hwhealth

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// parseWinPD keys disks by UniqueId. remembered is the Storage Spaces member
// map (read-only here): a pooled disk in Lost Communication reports its pool
// member GUID as UniqueId, and must stay on its own row (#6895).
func parseWinPD(b []byte, remembered map[string]string) (Result, error) {
	doc, e := decodeWinPD(b)
	if e != nil {
		return Result{}, e
	}
	return buildWinPD(doc, nil, remembered), nil
}

type winPDDoc struct {
	Disks    []windowsDisk
	Warnings []string
}

func decodeWinPD(b []byte) (winPDDoc, error) {
	var doc winPDDoc
	if e := json.Unmarshal(b, &doc); e != nil {
		return doc, e
	}
	if doc.Disks == nil {
		return doc, fmt.Errorf("missing Disks")
	}
	return doc, nil
}

// buildWinPD turns the inventory into components. counters is nil when the
// inventory carries its own counter fields (fixtures); otherwise a disk the
// counter run did not answer for keeps nil counters and gets a warning.
func buildWinPD(doc winPDDoc, counters map[string]winPDCounter, remembered map[string]string) Result {
	r := Result{Complete: true, Warnings: doc.Warnings}
	for _, d := range doc.Disks {
		if d.UniqueId == "" {
			r.Complete = false
			r.Warnings = append(r.Warnings, "disk UniqueId missing")
			continue
		}
		if counters != nil {
			if c, ok := counters[d.UniqueId]; ok && !c.Error {
				d.Temperature, d.Wear, d.ReadErrorsTotal, d.WriteErrorsTotal = c.Temperature, c.Wear, c.ReadErrorsTotal, c.WriteErrorsTotal
			} else {
				r.Warnings = append(r.Warnings, "Reliability counters unavailable for "+d.UniqueId)
			}
		}
		r.Components = append(r.Components, diskComponent("windows_physical_disk", "winpd:"+memberUniqueID(d, remembered, false), "", d))
	}
	return r
}

// winPDCounter is one line of winPDCountersScript output.
type winPDCounter struct {
	UniqueId                          string
	Error                             bool
	Temperature, Wear                 *int
	ReadErrorsTotal, WriteErrorsTotal *int64
}

var utf8BOM = []byte("\xef\xbb\xbf")

// parseWinPDCounters reads the counter run's line-per-disk JSON. Lines that do
// not parse (the cut-off last line of a run killed at its deadline, stray host
// output) are skipped: their disks simply have no counters.
func parseWinPDCounters(b []byte) map[string]winPDCounter {
	out := map[string]winPDCounter{}
	for _, line := range bytes.Split(b, []byte("\n")) {
		line = bytes.TrimSpace(bytes.TrimPrefix(bytes.TrimSpace(line), utf8BOM))
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var c winPDCounter
		if json.Unmarshal(line, &c) != nil || c.UniqueId == "" {
			continue
		}
		out[c.UniqueId] = c
	}
	return out
}

// Inventory and reliability counters run as two PowerShell processes with
// separate budgets (#10753). Get-StorageReliabilityCounter can be slow enough
// to hit a deadline on healthy hosts; sharing one process with Get-PhysicalDisk
// meant that timeout threw away the disk inventory and failed the source. A
// deadline can only interrupt a hung cmdlet by killing the process, so the
// split has to be two runs, not a stopwatch inside one script.
const (
	winPDInventoryTimeout = 60 * time.Second
	winPDCountersTimeout  = 45 * time.Second
)

const winPDInventoryScript = `$ErrorActionPreference='Stop'
$disks=@()
foreach($d in @(Get-PhysicalDisk)) {
 $disks += [pscustomobject]@{UniqueId=[string]$d.UniqueId;ObjectId=[string]$d.ObjectId;SerialNumber=$d.SerialNumber;FriendlyName=$d.FriendlyName;Model=$d.Model;FirmwareVersion=$d.FirmwareVersion;HealthStatus=[string]$d.HealthStatus;OperationalStatus=@($d.OperationalStatus|ForEach-Object{[string]$_});Usage=[string]$d.Usage;Size=$d.Size}
}
[pscustomobject]@{Disks=@($disks);Warnings=@()} | ConvertTo-Json -Depth 3 -Compress`

// winPDCountersScript writes and flushes one compressed JSON line per disk as
// soon as that disk answers, so a run killed at its deadline still hands back
// the counters it had already read.
const winPDCountersScript = `$ErrorActionPreference='Stop'
foreach($d in @(Get-PhysicalDisk)) {
 try { $r=$d | Get-StorageReliabilityCounter -ErrorAction Stop; $o=[pscustomobject]@{UniqueId=[string]$d.UniqueId;Temperature=$(if($r){$r.Temperature}else{$null});Wear=$(if($r){$r.Wear}else{$null});ReadErrorsTotal=$(if($r){$r.ReadErrorsTotal}else{$null});WriteErrorsTotal=$(if($r){$r.WriteErrorsTotal}else{$null})} } catch { $o=[pscustomobject]@{UniqueId=[string]$d.UniqueId;Error=$true} }
 [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush()
}`

// psRunner runs a static PowerShell script with a timeout (runPowerShell on
// Windows; a fake in tests).
type psRunner func(context.Context, time.Duration, string) (execResult, error)

// collectWinPD fails the source only when Get-PhysicalDisk itself fails, so a
// real inventory failure still alerts. The reliability counters are
// best-effort: a slow, failed or partial counter run keeps the inventory and
// records warnings instead.
func collectWinPD(ctx context.Context, run psRunner, remembered map[string]string) (Result, error) {
	o, e := run(ctx, winPDInventoryTimeout, winPDInventoryScript)
	if e != nil {
		return Result{}, e
	}
	if o.ExitCode != 0 {
		return Result{}, fmt.Errorf("Get-PhysicalDisk exit %d", o.ExitCode)
	}
	doc, e := decodeWinPD(o.Stdout)
	if e != nil {
		return Result{}, e
	}
	c, e := run(ctx, winPDCountersTimeout, winPDCountersScript)
	counters := parseWinPDCounters(c.Stdout)
	problem := ""
	if e != nil {
		problem = e.Error()
	} else if c.ExitCode != 0 {
		problem = fmt.Sprintf("exit %d", c.ExitCode)
	}
	if problem != "" {
		// First, so the 50-warning snapshot cap never drops the cause.
		doc.Warnings = append([]string{fmt.Sprintf("Reliability counters incomplete (%s); %d of %d disks reported", problem, len(counters), len(doc.Disks))}, doc.Warnings...)
	}
	return buildWinPD(doc, counters, remembered), nil
}
