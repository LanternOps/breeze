//go:build windows

package timesync

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
)

func eventScript(since, until time.Time, limit int) string {
	start := ""
	if !since.IsZero() {
		start = fmt.Sprintf(";StartTime=[datetime]::Parse('%s',[Globalization.CultureInfo]::InvariantCulture)", since.UTC().Format(time.RFC3339Nano))
	}
	return fmt.Sprintf(`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
try {
 $rows=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Time-Service'%s;EndTime=[datetime]::Parse('%s',[Globalization.CultureInfo]::InvariantCulture)} -MaxEvents %d -ErrorAction Stop)
} catch {
 if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
 $rows=@()
}
function Clip([string]$s,[int]$n) {
 if ($s.Length -le $n) { return $s }
 if ([char]::IsHighSurrogate($s[$n-1])) { $n-- }
 return $s.Substring(0,$n)
}
$result=@($rows | ForEach-Object {
 $entry=$_; $message=''; try { $message=[string]$entry.Message } catch { $message='' }
 [pscustomobject]@{
  recordId=[long]$entry.RecordId; eventId=[int]$entry.Id; level=[int]$entry.Level;
  occurredAt=$entry.TimeCreated.ToUniversalTime().ToString('o');
  message=(Clip $message 1000);
  properties=@($entry.Properties | Select-Object -First 10 | ForEach-Object { Clip ([Convert]::ToString($_.Value,[Globalization.CultureInfo]::InvariantCulture)) 500 })
 }
}); ConvertTo-Json -InputObject $result -Depth 5 -Compress`, start, until.UTC().Format(time.RFC3339Nano), limit)
}
func decodeEvents(b []byte) ([]Event, error) {
	events := []Event{}
	if err := json.Unmarshal(b, &events); err != nil {
		return nil, fmt.Errorf("decode Time-Service events: %w", err)
	}
	if events == nil {
		return nil, fmt.Errorf("event query returned null instead of an array")
	}
	return events, nil
}
func (*windowsSystem) Events(ctx context.Context, since, until time.Time, limit int) ([]Event, error) {
	if limit < 1 || limit > 100 {
		return nil, fmt.Errorf("invalid event limit %d", limit)
	}
	b, err := collectors.RunCollectorOutput(ctx, 30*time.Second, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", eventScript(since, until, limit))
	if err != nil {
		return nil, err
	}
	return decodeEvents(b)
}
func (s *windowsSystem) RecentEvents(ctx context.Context, until time.Time, limit int) ([]Event, error) {
	return s.Events(ctx, time.Time{}, until, limit)
}
