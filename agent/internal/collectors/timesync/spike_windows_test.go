//go:build windows && timesync_spike

package timesync

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
	"unsafe"
)

func TestSpikePublishedRPCLayouts(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("this probe checks amd64 layouts")
	}
	if unsafe.Sizeof(w32timeNTPProviderData{}) != 24 {
		t.Fatal("provider layout is not 24 bytes")
	}
	if unsafe.Sizeof(w32timeNTPPeerInfo{}) != 56 {
		t.Fatal("peer layout is not 56 bytes")
	}
	if unsafe.Offsetof(w32timeNTPPeerInfo{}.WszUniqueName) != 40 {
		t.Fatal("peer name offset is not 40")
	}
}

func TestTimeSyncStatusSpike(t *testing.T) {
	if os.Getenv("TIMESYNC_SPIKE") != "1" {
		t.Skip("explicit native lab opt-in required")
	}
	p := syscall.NewLazyDLL("w32time.dll").NewProc("W32TimeQueryNTPProviderStatus")
	t.Logf("method1 export lookup: %v", p.Find())
	t.Log("method1 invocation disabled: export presence does not establish DLL ABI or free function")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "w32tm.exe", "/query", "/status", "/verbose").CombinedOutput()
	t.Logf("method2 exit=%v raw=%q", err, output)
	ctx2, cancel2 := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel2()
	output, err = exec.CommandContext(ctx2, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", spikeEvents).CombinedOutput()
	if err != nil {
		t.Fatalf("method3 query failed: %v: %s", err, output)
	}
	var rows []map[string]any
	if err = json.Unmarshal(output, &rows); err != nil {
		t.Fatalf("method3 JSON: %v: %s", err, output)
	}
	for _, row := range rows {
		t.Logf("method3 %s", mustSpikeJSON(row))
	}
}

func mustSpikeJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprint(err)
	}
	return string(b)
}

// W32TIME_NTP_PROVIDER_DATA and W32TIME_NTP_PEER_INFO from MS-W32T.
// These are published RPC data declarations, NOT a verified DLL-call contract.
// Do not cast a DLL return buffer to either until its actual SDK ABI is established.
type w32timeNTPProviderData struct {
	UlSize       uint32
	UlError      uint32
	UlErrorMsgId uint32
	CPeerInfo    uint32
	PPeerInfo    *w32timeNTPPeerInfo
}

type w32timeNTPPeerInfo struct {
	UlSize                uint32
	UlResolveAttempts     uint32
	U64TimeRemaining      uint64
	U64LastSuccessfulSync uint64
	UlLastSyncError       uint32
	UlLastSyncErrorMsgId  uint32
	UlValidDataCounter    uint32
	UlAuthTypeMsgId       uint32
	WszUniqueName         *uint16
	UlMode                byte
	UlStratum             byte
	UlReachability        byte
	UlPeerPollInterval    byte
	UlHostPollInterval    byte
}

const spikeEvents = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;
$ErrorActionPreference='Stop';
try {
  $r=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Time-Service';Id=35,37;StartTime=(Get-Date).AddDays(-1)} -MaxEvents 20 -ErrorAction Stop)
} catch {
  if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
  $r=@()
}
$a=@($r | ForEach-Object {
  [pscustomobject]@{
    recordId=[long]$_.RecordId; eventId=[int]$_.Id;
    occurredAt=$_.TimeCreated.ToUniversalTime().ToString('o');
    properties=@($_.Properties | ForEach-Object { [Convert]::ToString($_.Value,[Globalization.CultureInfo]::InvariantCulture) });
    message=[string]$_.Message
  }
}); ConvertTo-Json -InputObject $a -Depth 5 -Compress`
