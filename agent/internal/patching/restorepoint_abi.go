package patching

import "encoding/binary"

// RESTOREPOINTINFOW / STATEMGRSTATUS as passed to srclient!SRSetRestorePointW.
// The Windows SDK (srrestoreptapi.h) declares both inside `#pragma pack(1)`
// with an INT64 llSequenceNumber. The field types are load-bearing and
// asserted by restorepoint_abi_test.go — see #4752 and
// agent/cmd/srprobe/README.md before changing either.
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
