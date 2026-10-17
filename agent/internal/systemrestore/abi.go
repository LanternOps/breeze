package systemrestore

import (
	"encoding/binary"
	"errors"
	"unicode/utf16"
)

// RESTOREPOINTINFOW / STATEMGRSTATUS as passed to srclient!SRSetRestorePointW.
// The Windows SDK (srrestoreptapi.h) declares both inside `#pragma pack(1)`
// with an INT64 llSequenceNumber. The field types are load-bearing and
// asserted by abi_test.go — see #4752 and agent/cmd/srprobe/README.md before
// changing either.
//
// This file has no build tag on purpose: the layouts contain no
// pointer-sized fields, so they are identical on every GOOS/GOARCH and the
// regression test runs in the Linux agent CI job too.

// restorePointInfo is RESTOREPOINTINFOW (528 bytes). The two DWORDs already
// place the INT64 on an 8-byte boundary, so Go's natural layout matches the
// packed C layout with no padding: szDescription is at offset 16.
type restorePointInfo struct {
	EventType        uint32
	RestorePointType uint32
	SequenceNumber   int64
	Description      [256]uint16
}

// statemgrStatus is STATEMGRSTATUS (12 bytes). Under pack(1) the INT64
// follows nStatus directly at offset 4; Go would pad an int64 field to
// offset 8, so the sequence number is held as raw little-endian bytes.
type statemgrStatus struct {
	Status         uint32
	SequenceNumber [8]byte
}

// sequence decodes llSequenceNumber.
func (s *statemgrStatus) sequence() int64 {
	return int64(binary.LittleEndian.Uint64(s.SequenceNumber[:]))
}

const (
	beginSystemChange  = 100 // BEGIN_SYSTEM_CHANGE
	endSystemChange    = 101 // END_SYSTEM_CHANGE
	applicationInstall = 0   // APPLICATION_INSTALL

	// statusCanary pre-fills every status buffer, as the srprobe harness does.
	// A buffer the DLL never wrote then reads as nStatus=0xCCCCCCCC — a
	// failure — instead of a zero that looks like success.
	statusCanary = 0xCC
)

// newStatemgrStatus returns a canary-filled status buffer.
func newStatemgrStatus() statemgrStatus {
	var st statemgrStatus
	st.Status = statusCanary * 0x01010101
	for i := range st.SequenceNumber {
		st.SequenceNumber[i] = statusCanary
	}
	return st
}

// restorePointInfoFor builds the RESTOREPOINTINFOW for one call. An over-long
// description is truncated so the last slot holds the terminator; one with an
// embedded NUL is rejected, since the DLL would silently drop everything after
// it and identity verification would then fail for a reason nobody could see.
func restorePointInfoFor(eventType uint32, sequence int64, description string) (restorePointInfo, error) {
	rpi := restorePointInfo{
		EventType:        eventType,
		RestorePointType: applicationInstall,
		SequenceNumber:   sequence,
	}
	units := utf16.Encode([]rune(description))
	for _, u := range units {
		if u == 0 {
			return restorePointInfo{}, errors.New("restore point description contains a NUL character")
		}
	}
	if len(units) > len(rpi.Description)-1 {
		units = units[:len(rpi.Description)-1]
	}
	copy(rpi.Description[:], units) // the zero value supplies the terminator
	return rpi, nil
}

// comInitDisposition interprets a CoInitializeEx HRESULT. S_OK and S_FALSE
// ("already initialised on this thread") are both successes that owe a
// CoUninitialize. RPC_E_CHANGED_MODE means COM is already up in the other
// apartment model: usable, but it is not ours to uninitialise. Anything else
// is a failure that must not be uninitialised.
func comInitDisposition(hr uintptr) (proceed, uninit bool) {
	switch uint32(hr) {
	case 0, 1: // S_OK, S_FALSE
		return true, true
	case 0x80010106: // RPC_E_CHANGED_MODE
		return true, false
	default:
		return false, false
	}
}
