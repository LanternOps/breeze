//go:build windows

// Command srprobe settles Open Decision 1 of #4609: which memory layout of
// RESTOREPOINTINFOW / STATEMGRSTATUS does srclient.dll actually use?
//
// Three candidates are probed:
//
//	A — as shipped in agent/internal/patching before #4752: llSequenceNumber
//	    declared uint32 in both structs (szDescription at offset 12,
//	    STATEMGRSTATUS 8 bytes).
//	B — INT64 with natural x64 alignment (STATEMGRSTATUS 16 bytes, sequence
//	    at offset 8).
//	C — the Windows SDK header verbatim: INT64 under #pragma pack(1)
//	    (RESTOREPOINTINFOW 528 bytes with szDescription at 16, STATEMGRSTATUS
//	    12 bytes with the sequence at offset 4).
//
// The status buffer passed to every call is 16 bytes pre-filled with 0xCC, so
// the bytes the DLL writes are visible directly regardless of which Go struct
// is "right". The description offset is settled by reading back the created
// point's description: under layout A the DLL starts reading two UTF-16 units
// late, so the description comes back with its first two characters missing.
// The returned sequence number is settled by issuing END_SYSTEM_CHANGE with
// the sequence decoded per layout C: a wrong decode makes END fail.
//
// THROWAWAY DIAGNOSTIC. It creates real restore points, so run it only on a
// disposable test machine. It never changes System Restore configuration.
package main

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// Layout A — exactly as shipped (preflight_windows.go before #4752).
type restorePointInfoA struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   uint32
	Description      [256]uint16
}

// Layouts B and C share this RESTOREPOINTINFOW shape: two DWORDs already put
// the INT64 on an 8-byte boundary, so packed and natural alignment agree.
type restorePointInfoC struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   int64
	Description      [256]uint16
}

const (
	beginSystemChange  = 100
	endSystemChange    = 101
	applicationInstall = 0
	canary             = 0xCC
)

type statusBuf [16]byte

func newStatusBuf() statusBuf {
	var b statusBuf
	for i := range b {
		b[i] = canary
	}
	return b
}

func (b *statusBuf) report(label string) {
	last := -1
	for i := range b {
		if b[i] != canary {
			last = i
		}
	}
	fmt.Printf("  %s status bytes: %s (highest offset changed from canary: %d)\n",
		label, hex.EncodeToString(b[:]), last)
	fmt.Printf("    decode A (uint32 seq @4):  nStatus=%d seq=%d\n",
		binary.LittleEndian.Uint32(b[0:4]), binary.LittleEndian.Uint32(b[4:8]))
	fmt.Printf("    decode B (int64 seq @8):   nStatus=%d seq=%d\n",
		binary.LittleEndian.Uint32(b[0:4]), int64(binary.LittleEndian.Uint64(b[8:16])))
	fmt.Printf("    decode C (int64 seq @4):   nStatus=%d seq=%d\n",
		binary.LittleEndian.Uint32(b[0:4]), int64(binary.LittleEndian.Uint64(b[4:12])))
}

func (b *statusBuf) seqC() int64 { return int64(binary.LittleEndian.Uint64(b[4:12])) }

func main() {
	fmt.Printf("srprobe — %s\n", time.Now().UTC().Format(time.RFC3339))
	fmt.Printf("Go struct sizes:\n")
	fmt.Printf("  A: sizeof(RESTOREPOINTINFOW)=%d offsetof(szDescription)=%d sizeof(STATEMGRSTATUS)=8\n",
		unsafe.Sizeof(restorePointInfoA{}), unsafe.Offsetof(restorePointInfoA{}.Description))
	fmt.Printf("  C: sizeof(RESTOREPOINTINFOW)=%d offsetof(szDescription)=%d sizeof(STATEMGRSTATUS)=12 (SDK, pack(1))\n",
		unsafe.Sizeof(restorePointInfoC{}), unsafe.Offsetof(restorePointInfoC{}.Description))
	osInfo()
	freq()

	dll := windows.NewLazySystemDLL("srclient.dll")
	proc := dll.NewProc("SRSetRestorePointW")
	if err := proc.Find(); err != nil {
		fmt.Printf("RESULT: SRSetRestorePointW not available: %v\n", err)
		fmt.Println("VERDICT: unsupported on this machine (entry point missing); layout cannot be observed here")
		os.Exit(2)
	}
	fmt.Println("SRSetRestorePointW: found")

	stamp := time.Now().UTC().Format("150405")

	// Probe A — the shipped call, byte for byte (BEGIN only, no END).
	descA := "BREEZE-PROBE-A-" + stamp
	rpiA := restorePointInfoA{EventType: beginSystemChange, RestorePointType: applicationInstall}
	copyDesc(rpiA.Description[:], descA)
	stA := newStatusBuf()
	rA, _, errA := proc.Call(uintptr(unsafe.Pointer(&rpiA)), uintptr(unsafe.Pointer(&stA)))
	fmt.Printf("\nProbe A (shipped layout, BEGIN only): ret=%d callErr=%v desc=%q\n", rA, errA, descA)
	stA.report("A")

	// The default creation frequency (1440 min) makes the DLL reuse the probe-A
	// point for probe C. The README tells the operator how to lift it on a test
	// box; the harness only reports what it sees.
	time.Sleep(2 * time.Second)

	// Probe C — the SDK layout, BEGIN then END with the sequence decoded per C.
	descC := "BREEZE-PROBE-C-" + stamp
	rpiC := restorePointInfoC{EventType: beginSystemChange, RestorePointType: applicationInstall}
	copyDesc(rpiC.Description[:], descC)
	stC := newStatusBuf()
	rC, _, errC := proc.Call(uintptr(unsafe.Pointer(&rpiC)), uintptr(unsafe.Pointer(&stC)))
	fmt.Printf("\nProbe C (SDK layout, BEGIN): ret=%d callErr=%v desc=%q\n", rC, errC, descC)
	stC.report("C-begin")

	// END only a BEGIN that actually succeeded; a throttled or failed BEGIN
	// would make the END result meaningless.
	if uint32(rC) != 0 && binary.LittleEndian.Uint32(stC[0:4]) == 0 {
		end := restorePointInfoC{EventType: endSystemChange, RestorePointType: applicationInstall, SequenceNumber: stC.seqC()}
		stE := newStatusBuf()
		rE, _, errE := proc.Call(uintptr(unsafe.Pointer(&end)), uintptr(unsafe.Pointer(&stE)))
		fmt.Printf("\nProbe C (SDK layout, END seq=%d): ret=%d callErr=%v\n", end.SequenceNumber, rE, errE)
		stE.report("C-end")
	}

	fmt.Println("\n--- root\\default:SystemRestore enumeration ---")
	ps("Get-CimInstance -Namespace root/default -ClassName SystemRestore | " +
		"Select-Object SequenceNumber,Description,CreationTime,RestorePointType,EventType | Format-List")
}

func copyDesc(dst []uint16, s string) {
	u, err := windows.UTF16FromString(s)
	if err != nil {
		panic(err)
	}
	if len(u) > len(dst) {
		u = append(u[:len(dst)-1], 0)
	}
	copy(dst, u)
}

func osInfo() {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		fmt.Printf("OS: (unreadable: %v)\n", err)
		return
	}
	defer k.Close()
	name, _, _ := k.GetStringValue("ProductName")
	disp, _, _ := k.GetStringValue("DisplayVersion")
	build, _, _ := k.GetStringValue("CurrentBuildNumber")
	ubr, _, _ := k.GetIntegerValue("UBR")
	inst, _, _ := k.GetStringValue("InstallationType")
	fmt.Printf("OS: %s %s (%s) build %s.%d\n", name, disp, inst, build, ubr)
}

func freq() {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\SystemRestore`, registry.QUERY_VALUE)
	if err != nil {
		fmt.Printf("SystemRestorePointCreationFrequency: key unreadable (%v)\n", err)
		return
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("SystemRestorePointCreationFrequency")
	if err != nil {
		fmt.Println("SystemRestorePointCreationFrequency: not set (default 1440 minutes)")
		return
	}
	fmt.Printf("SystemRestorePointCreationFrequency: %d minutes\n", v)
}

func ps(cmd string) {
	// PowerShell rather than a WMI binding: this is a throwaway diagnostic and
	// the shipped verifier (W02) does its own typed enumeration.
	out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", cmd).CombinedOutput()
	fmt.Println(strings.TrimSpace(string(out)))
	if err != nil {
		fmt.Printf("(enumeration error: %v)\n", err)
	}
}
