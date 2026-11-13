package tools

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/psscript"
)

// taskDetailScript is the PowerShell run by getTaskOS for one scheduled task.
// It writes the task line in the listTasksScript format, then TRIG and ACT
// lines.
func taskDetailScript(path string) string {
	return fmt.Sprintf(`$ErrorActionPreference='SilentlyContinue'
$U=[char]31
function B($s){[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$s))}
$fullPath=%s
$t=Get-ScheduledTask|Where-Object{($_.TaskPath+$_.TaskName)-eq $fullPath}|Select-Object -First 1
if(-not $t){Write-Error "Task not found: $fullPath";exit 1}
$i=$t|Get-ScheduledTaskInfo
$lr='';$nr='';$res=''
if($i){
  if($i.LastRunTime.Year -gt 1601){$lr=$i.LastRunTime.ToString('o')}
  if($i.NextRunTime.Year -gt 1601){$nr=$i.NextRunTime.ToString('o')}
  $res=[string][int]$i.LastTaskResult
}
$f=$t.TaskPath.TrimEnd('\')
if(-not $f){$f='\'}
$trigs=@($t.Triggers|ForEach-Object{
  $c=$_.CimClass.CimClassName-replace'MSFT_Task','' -replace'Trigger',''
  switch($c){
    'Registration'{'At task creation'}
    'Boot'{'At startup'}
    'Logon'{'At log on'}
    'Idle'{'On idle'}
    'Time'{'One time'}
    'Daily'{'Daily'}
    'Weekly'{'Weekly'}
    'Monthly'{'Monthly'}
    'Event'{'On event'}
    'SessionStateChange'{'On session change'}
    default{$c}
  }
})
$trigB64=($trigs|ForEach-Object{B $_})-join'|'
Write-Output ((B $t.TaskName)+$U+(B($t.TaskPath+$t.TaskName))+$U+(B $f)+$U+$t.State.ToString().ToLower()+$U+(B $t.Author)+$U+(B $t.Description)+$U+$lr+$U+$nr+$U+$res+$U+$trigB64)
$t.Triggers|ForEach-Object{
  $c=$_.CimClass.CimClassName-replace'MSFT_Task','' -replace'Trigger',''
  $type=switch($c){
    'Registration'{'registration'}
    'Boot'{'boot'}
    'Logon'{'logon'}
    'Idle'{'idle'}
    'Time'{'time'}
    'Daily'{'daily'}
    'Weekly'{'weekly'}
    'Monthly'{'monthly'}
    'Event'{'event'}
    'SessionStateChange'{'session_change'}
    default{$c.ToLower()}
  }
  $en=if($_.Enabled){'true'}else{'false'}
  Write-Output ('TRIG'+$U+$type+$U+$en+$U+(B $_.StartBoundary))
}
$t.Actions|ForEach-Object{
  $atype=if($_.CimClass.CimClassName-eq'MSFT_TaskExecAction'){'execute'}
         else{$_.CimClass.CimClassName.ToLower()-replace'MSFT_Task','' -replace'Action',''}
  Write-Output ('ACT'+$U+$atype+$U+(B $_.Execute)+$U+(B $_.Arguments))
}`, psscript.Quote(path))
}

// taskHistoryScript is the PowerShell run by getTaskHistoryOS: up to limit
// Task Scheduler operational events for the task at path, as JSON.
func taskHistoryScript(path string, limit int) string {
	return fmt.Sprintf(`$taskPath = %s
$limit = %d
$maxScan = 2000
$events = Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -ErrorAction SilentlyContinue -MaxEvents $maxScan
$history = @()
foreach ($event in $events) {
  try {
    $xml = [xml]$event.ToXml()
    $taskNode = $xml.Event.EventData.Data | Where-Object { $_.Name -eq 'TaskName' } | Select-Object -First 1
    if (-not $taskNode) { continue }
    $eventTaskPath = [string]$taskNode.'#text'
    if ($eventTaskPath -ne $taskPath) { continue }

    $resultCodeNode = $xml.Event.EventData.Data | Where-Object { $_.Name -eq 'ResultCode' } | Select-Object -First 1
    $resultCode = $null
    if ($resultCodeNode) {
      $rawResult = [string]$resultCodeNode.'#text'
      if ($rawResult -match '^0x[0-9a-fA-F]+$') {
        $resultCode = [int]$rawResult
      } elseif ($rawResult -match '^-?\d+$') {
        $resultCode = [int]$rawResult
      }
    }

    $history += [PSCustomObject]@{
      id = [string]$event.RecordId
      eventId = [int]$event.Id
      timestamp = $event.TimeCreated.ToString('o')
      level = [string]$event.LevelDisplayName
      message = [string]$event.Message
      resultCode = $resultCode
    }
    if ($history.Count -ge $limit) { break }
  } catch {
    continue
  }
}

$history | ConvertTo-Json -Depth 4 -Compress`, psscript.Quote(path), limit)
}
