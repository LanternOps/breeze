package systemrestore

import (
	"strings"
	"testing"
	"unicode/utf16"
	"unsafe"
)

// These assertions pin the srclient.dll ABI (#4752, Open Decision 1 of #4609).
//
// The Windows SDK header srrestoreptapi.h declares both structs inside
// `#pragma pack(1)`:
//
//	typedef struct _RESTOREPTINFOW {
//	    DWORD dwEventType;        // offset 0
//	    DWORD dwRestorePtType;    // offset 4
//	    INT64 llSequenceNumber;   // offset 8
//	    WCHAR szDescription[256]; // offset 16
//	} RESTOREPOINTINFOW;          // 528 bytes
//
//	typedef struct _SMGRSTATUS {
//	    DWORD nStatus;            // offset 0
//	    INT64 llSequenceNumber;   // offset 4 — packed, no alignment padding
//	} STATEMGRSTATUS;             // 12 bytes
//
// The agent previously declared llSequenceNumber as uint32 in both, which put
// szDescription at offset 12 (the DLL read the description two characters
// late) and made the status buffer 8 bytes while the DLL writes 12. The
// hardware run recorded in agent/cmd/srprobe/README.md is the evidence.

func TestRestorePointInfoLayout(t *testing.T) {
	var rpi restorePointInfo
	checks := []struct {
		what      string
		got, want uintptr
	}{
		{"offsetof(dwEventType)", unsafe.Offsetof(rpi.EventType), 0},
		{"offsetof(dwRestorePtType)", unsafe.Offsetof(rpi.RestorePointType), 4},
		{"sizeof(llSequenceNumber)", unsafe.Sizeof(rpi.SequenceNumber), 8},
		{"offsetof(llSequenceNumber)", unsafe.Offsetof(rpi.SequenceNumber), 8},
		{"offsetof(szDescription)", unsafe.Offsetof(rpi.Description), 16},
		{"sizeof(szDescription)", unsafe.Sizeof(rpi.Description), 512},
		{"sizeof(RESTOREPOINTINFOW)", unsafe.Sizeof(rpi), 528},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("RESTOREPOINTINFOW %s = %d, want %d (srrestoreptapi.h, pack(1))", c.what, c.got, c.want)
		}
	}
}

func TestStatemgrStatusLayout(t *testing.T) {
	var st statemgrStatus
	checks := []struct {
		what      string
		got, want uintptr
	}{
		{"offsetof(nStatus)", unsafe.Offsetof(st.Status), 0},
		{"sizeof(llSequenceNumber)", unsafe.Sizeof(st.SequenceNumber), 8},
		{"offsetof(llSequenceNumber)", unsafe.Offsetof(st.SequenceNumber), 4},
		{"sizeof(STATEMGRSTATUS)", unsafe.Sizeof(st), 12},
	}
	for _, c := range checks {
		if c.got != c.want {
			t.Errorf("STATEMGRSTATUS %s = %d, want %d (srrestoreptapi.h, pack(1))", c.what, c.got, c.want)
		}
	}
}

func TestStatemgrStatusSequenceDecode(t *testing.T) {
	// Bytes as the DLL writes them: nStatus=0, then a little-endian INT64
	// that does not fit in 32 bits, so a uint32 read would truncate it.
	raw := [12]byte{0, 0, 0, 0, 0x2a, 0, 0, 0, 0x01, 0, 0, 0}
	var st statemgrStatus
	copy((*[12]byte)(unsafe.Pointer(&st))[:], raw[:])
	if got, want := st.sequence(), int64(1<<32|0x2a); got != want {
		t.Fatalf("statemgrStatus.sequence() = %d, want %d", got, want)
	}
}

func TestNewStatemgrStatusIsCanaryFilled(t *testing.T) {
	// An untouched buffer must read as a failure: if the DLL never writes
	// nStatus, the canary is nonzero and restorePointCallFailed rejects it.
	st := newStatemgrStatus()
	raw := (*[12]byte)(unsafe.Pointer(&st))
	for i, b := range raw {
		if b != statusCanary {
			t.Fatalf("byte %d = %#x, want canary %#x", i, b, statusCanary)
		}
	}
	if _, failed := restorePointCallFailed(1, st.Status); !failed {
		t.Fatal("a status buffer the DLL never wrote was accepted as success")
	}
}

func TestRestorePointInfoFor(t *testing.T) {
	rpi, err := restorePointInfoFor(beginSystemChange, 0, "Before install: KB1 [abcd1234]")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if rpi.EventType != 100 || rpi.RestorePointType != 0 || rpi.SequenceNumber != 0 {
		t.Fatalf("header = %+v", rpi)
	}
	want := utf16.Encode([]rune("Before install: KB1 [abcd1234]"))
	for i, u := range want {
		if rpi.Description[i] != u {
			t.Fatalf("Description[%d] = %#x, want %#x", i, rpi.Description[i], u)
		}
	}
	if rpi.Description[len(want)] != 0 {
		t.Fatal("description is not NUL-terminated")
	}

	end, err := restorePointInfoFor(endSystemChange, 1<<40, "")
	if err != nil || end.EventType != 101 || end.SequenceNumber != 1<<40 || end.Description[0] != 0 {
		t.Fatalf("END struct = %+v, err = %v", end, err)
	}

	if _, err := restorePointInfoFor(beginSystemChange, 0, "nul\x00inside"); err == nil {
		t.Fatal("a description with an embedded NUL must be rejected, not silently truncated")
	}

	long, err := restorePointInfoFor(beginSystemChange, 0, strings.Repeat("x", 400))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if long.Description[255] != 0 {
		t.Fatal("an over-long description must be truncated with a terminator in the last slot")
	}
}

func TestComInitDisposition(t *testing.T) {
	tests := []struct {
		name            string
		hr              uintptr
		proceed, uninit bool
	}{
		{"S_OK", 0, true, true},
		{"S_FALSE: already initialised, still owes CoUninitialize", 1, true, true},
		{"RPC_E_CHANGED_MODE: usable, must NOT be uninitialised", 0x80010106, true, false},
		{"E_OUTOFMEMORY", 0x8007000E, false, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			proceed, uninit := comInitDisposition(tc.hr)
			if proceed != tc.proceed || uninit != tc.uninit {
				t.Fatalf("comInitDisposition(%#x) = (%v, %v), want (%v, %v)", tc.hr, proceed, uninit, tc.proceed, tc.uninit)
			}
		})
	}
}
