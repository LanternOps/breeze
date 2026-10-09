package patching

import (
	"testing"
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
