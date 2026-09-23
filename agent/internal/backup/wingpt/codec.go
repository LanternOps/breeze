// Package wingpt encodes and decodes the Win32 GPT partition-table wire
// formats (DRIVE_LAYOUT_INFORMATION_EX / PARTITION_INFORMATION_EX, as read
// and written by IOCTL_DISK_{GET,SET}_DRIVE_LAYOUT_EX) and wraps the disk
// IOCTLs the rebuild engine's Windows provisioning phase needs. The codec
// (this file) is untagged so it is covered by the ordinary test suite on
// every GOOS; the live IOCTL callers (ioctl_windows.go) only build and run
// on windows.
//
// Struct layouts below are pinned against Microsoft's published winioctl.h
// definitions (x64 ABI, 8-byte struct alignment) — see codec_test.go's
// TestEncodeDriveLayoutExByteOffsets for the pinning test and Part 0's
// "Package placement" for the field-by-field derivation this file
// implements.
package wingpt

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf16"
)

// Partition is one GPT partition entry, independent of any live disk handle
// — this is the pure data shape both the layout collector (fills Attributes
// from a live ReadLayout) and WinSystem (W06b, writes a planned Layout back
// with WriteLayout) share.
type Partition struct {
	Number     int
	TypeGUID   string // lower-case, no braces
	PartGUID   string // lower-case, no braces; required on encode (Windows never invents a GPT PartitionId — use NewGUID)
	Name       string // ≤ 36 UTF-16 code units (GPT partition name field width)
	StartBytes int64
	SizeBytes  int64
	Attributes uint64
}

// Layout is one disk's full GPT partition table.
type Layout struct {
	DiskGUID string // lower-case, no braces
	// SectorSize is NOT part of DRIVE_LAYOUT_INFORMATION_EX (it comes from
	// IOCTL_DISK_GET_LENGTH_INFO / IOCTL_STORAGE_QUERY_PROPERTY instead) and
	// is therefore left at its zero value by ReadLayout/DecodeDriveLayoutEx
	// in this wave — nothing in W06a consumes it. It exists on this struct
	// now so W06b's WinSystem.WriteGPT (which DOES need the sector size to
	// validate partition alignment) does not need a second parallel type.
	SectorSize int
	Partitions []Partition
}

// CtlCode replicates the CTL_CODE macro from <devioctl.h>:
// (deviceType << 16) | (access << 14) | (function << 2) | method. Every
// constant below is derived from this, and codec_test.go's TestCtlCode pins
// each one against its documented (deviceType, function, method, access)
// tuple — never hand-edit a hex literal here without updating that test.
func CtlCode(deviceType, function, method, access uint32) uint32 {
	return (deviceType << 16) | (access << 14) | (function << 2) | method
}

// Device types and access/method values used below (winioctl.h / devioctl.h).
const (
	fileDeviceDisk        = 0x00000007
	fileDeviceMassStorage = 0x0000002D
	fileDeviceFileSystem  = 0x00000009
	methodBuffered        = 0
	fileAnyAccess         = 0
	fileReadAccess        = 1
	fileReadWriteAccess   = fileReadAccess | 2
)

// Pinned IOCTL/FSCTL constants (see codec_test.go TestCtlCode).
var (
	IOCTLDiskGetDriveLayoutEx   = CtlCode(fileDeviceDisk, 0x14, methodBuffered, fileAnyAccess)         // 0x00070050
	IOCTLDiskSetDriveLayoutEx   = CtlCode(fileDeviceDisk, 0x15, methodBuffered, fileReadWriteAccess)   // 0x0007C054
	IOCTLDiskCreateDisk         = CtlCode(fileDeviceDisk, 0x16, methodBuffered, fileReadWriteAccess)   // 0x0007C058
	IOCTLDiskDeleteDriveLayout  = CtlCode(fileDeviceDisk, 0x40, methodBuffered, fileReadWriteAccess)   // 0x0007C100
	IOCTLDiskUpdateProperties   = CtlCode(fileDeviceDisk, 0x50, methodBuffered, fileAnyAccess)         // 0x00070140
	IOCTLDiskGetLengthInfo      = CtlCode(fileDeviceDisk, 0x17, methodBuffered, fileReadAccess)        // 0x0007405C
	IOCTLStorageGetDeviceNumber = CtlCode(fileDeviceMassStorage, 0x420, methodBuffered, fileAnyAccess) // 0x002D1080
	IOCTLDiskGetDiskAttributes  = CtlCode(fileDeviceDisk, 0x3C, methodBuffered, fileAnyAccess)         // 0x000700F0
	FSCTLLockVolume             = CtlCode(fileDeviceFileSystem, 6, methodBuffered, fileAnyAccess)      // 0x00090018
	FSCTLDismountVolume         = CtlCode(fileDeviceFileSystem, 8, methodBuffered, fileAnyAccess)      // 0x00090020
)

// GUIDToBytes encodes a lower-case RFC-4122 GUID string
// ("xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx", braces optional) into the 16-byte
// mixed-endian layout Win32's GUID struct uses on the wire (and thus inside
// PARTITION_INFORMATION_GPT / DRIVE_LAYOUT_INFORMATION_GPT): Data1 (4 bytes)
// and Data2/Data3 (2 bytes each) are little-endian; Data4 (the last 8 bytes)
// is taken byte-for-byte in the order the string already presents it (it is
// itself defined as a big-endian byte array in the Win32 GUID struct, so no
// reversal is needed there).
func GUIDToBytes(s string) ([16]byte, error) {
	var out [16]byte
	s = strings.ToLower(strings.Trim(strings.TrimSpace(s), "{}"))
	parts := strings.Split(s, "-")
	if len(parts) != 5 || len(parts[0]) != 8 || len(parts[1]) != 4 || len(parts[2]) != 4 || len(parts[3]) != 4 || len(parts[4]) != 12 {
		return out, fmt.Errorf("wingpt: malformed GUID %q", s)
	}
	d1, err := strconv.ParseUint(parts[0], 16, 32)
	if err != nil {
		return out, fmt.Errorf("wingpt: decode GUID Data1 in %q: %w", s, err)
	}
	d2, err := strconv.ParseUint(parts[1], 16, 16)
	if err != nil {
		return out, fmt.Errorf("wingpt: decode GUID Data2 in %q: %w", s, err)
	}
	d3, err := strconv.ParseUint(parts[2], 16, 16)
	if err != nil {
		return out, fmt.Errorf("wingpt: decode GUID Data3 in %q: %w", s, err)
	}
	tail, err := hexDecode(parts[3] + parts[4])
	if err != nil || len(tail) != 8 {
		return out, fmt.Errorf("wingpt: decode GUID Data4 in %q: %w", s, err)
	}
	binary.LittleEndian.PutUint32(out[0:4], uint32(d1))
	binary.LittleEndian.PutUint16(out[4:6], uint16(d2))
	binary.LittleEndian.PutUint16(out[6:8], uint16(d3))
	copy(out[8:16], tail)
	return out, nil
}

// BytesToGUID is GUIDToBytes's inverse, producing a lower-case, unbraced
// GUID string.
func BytesToGUID(b [16]byte) string {
	d1 := binary.LittleEndian.Uint32(b[0:4])
	d2 := binary.LittleEndian.Uint16(b[4:6])
	d3 := binary.LittleEndian.Uint16(b[6:8])
	return fmt.Sprintf("%08x-%04x-%04x-%s-%s", d1, d2, d3, hexEncode(b[8:10]), hexEncode(b[10:16]))
}

// NewGUID returns a fresh random (version 4, RFC 4122 variant) GUID in the
// lower-case unbraced form this package uses everywhere.
func NewGUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("wingpt: generate GUID: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexEncode(b[0:4]), hexEncode(b[4:6]), hexEncode(b[6:8]), hexEncode(b[8:10]), hexEncode(b[10:16])), nil
}

func hexDecode(s string) ([]byte, error) {
	if len(s)%2 != 0 {
		return nil, fmt.Errorf("odd-length hex string %q", s)
	}
	out := make([]byte, len(s)/2)
	for i := range out {
		v, err := strconv.ParseUint(s[i*2:i*2+2], 16, 8)
		if err != nil {
			return nil, err
		}
		out[i] = byte(v)
	}
	return out, nil
}

func hexEncode(b []byte) string {
	const hexdigits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = hexdigits[v>>4]
		out[i*2+1] = hexdigits[v&0xF]
	}
	return string(out)
}

// driveLayoutHeaderSize/partitionEntrySize are DRIVE_LAYOUT_INFORMATION_EX's
// (GPT-variant) fixed header size and PARTITION_INFORMATION_EX's fixed
// entry size on the x64 ABI — see this file's package doc comment and
// codec_test.go's TestEncodeDriveLayoutExByteOffsets.
const (
	driveLayoutHeaderSize = 48
	partitionEntrySize    = 144
	partitionStyleGPT     = 1 // PARTITION_STYLE_GPT
)

// maxLayoutPartitions is the largest partition count a Windows GPT disk
// carries (the default GPT entry array: 128 entries). readRawLayout never
// grows its IOCTL buffer past room for this many entries.
const maxLayoutPartitions = 128

// initialLayoutBufferSize is readRawLayout's first IOCTL_DISK_GET_DRIVE_LAYOUT_EX
// output buffer: header plus 16 entries, enough for any ordinary disk.
const initialLayoutBufferSize = uint32(driveLayoutHeaderSize + 16*partitionEntrySize)

// nextLayoutBufferSize is readRawLayout's growth step after
// ERROR_INSUFFICIENT_BUFFER/ERROR_MORE_DATA: double, clamped to the
// 128-entry cap. ok is false once cur is already at the cap, so a device
// that keeps asking for more ends in an error instead of an unbounded
// allocation loop.
func nextLayoutBufferSize(cur uint32) (next uint32, ok bool) {
	const limit = uint32(driveLayoutHeaderSize + maxLayoutPartitions*partitionEntrySize)
	if cur >= limit {
		return cur, false
	}
	next = cur * 2
	if next > limit {
		next = limit
	}
	return next, true
}

// EncodeDriveLayoutEx builds the byte buffer IOCTL_DISK_SET_DRIVE_LAYOUT_EX
// expects for a GPT-style disk: a 48-byte header (PartitionStyle=GPT,
// PartitionCount, DiskId; StartingUsableOffset/UsableLength/
// MaxPartitionCount at 24..44 are left zero here and filled from the disk's
// CURRENT layout by WriteLayout via CopyUsableRange — Windows computes them
// at CREATE_DISK time) followed by one 144-byte PARTITION_INFORMATION_EX per
// partition. Every entry carries RewritePartition=TRUE (an entry with FALSE
// is ignored by SET) and an explicit PartitionId (Windows does not generate
// one for a zero GUID).
func EncodeDriveLayoutEx(l Layout) ([]byte, error) {
	buf := make([]byte, driveLayoutHeaderSize+len(l.Partitions)*partitionEntrySize)
	binary.LittleEndian.PutUint32(buf[0:4], partitionStyleGPT)
	binary.LittleEndian.PutUint32(buf[4:8], uint32(len(l.Partitions)))
	diskGUID, err := GUIDToBytes(l.DiskGUID)
	if err != nil {
		return nil, fmt.Errorf("wingpt: disk GUID: %w", err)
	}
	copy(buf[8:24], diskGUID[:])
	// buf[24:44] (StartingUsableOffset, UsableLength, MaxPartitionCount) and
	// buf[44:48] (alignment padding) are left zero — see the doc comment.

	for i, p := range l.Partitions {
		off := driveLayoutHeaderSize + i*partitionEntrySize
		binary.LittleEndian.PutUint32(buf[off:off+4], partitionStyleGPT)
		binary.LittleEndian.PutUint64(buf[off+8:off+16], uint64(p.StartBytes))
		binary.LittleEndian.PutUint64(buf[off+16:off+24], uint64(p.SizeBytes))
		binary.LittleEndian.PutUint32(buf[off+24:off+28], uint32(p.Number))
		buf[off+28] = 1 // RewritePartition = TRUE
		if p.PartGUID == "" {
			return nil, fmt.Errorf("wingpt: partition %d has no PartGUID (callers assign one with NewGUID)", p.Number)
		}
		// buf[off+29] (IsServicePartition) stays 0 — no partition this wave
		// provisions is an OEM service partition.
		typeGUID, err := GUIDToBytes(p.TypeGUID)
		if err != nil {
			return nil, fmt.Errorf("wingpt: partition %d type GUID: %w", p.Number, err)
		}
		copy(buf[off+32:off+48], typeGUID[:])
		partGUID, err := GUIDToBytes(p.PartGUID)
		if err != nil {
			return nil, fmt.Errorf("wingpt: partition %d part GUID: %w", p.Number, err)
		}
		copy(buf[off+48:off+64], partGUID[:])
		binary.LittleEndian.PutUint64(buf[off+64:off+72], p.Attributes)
		units := utf16.Encode([]rune(p.Name))
		if len(units) > 36 {
			return nil, fmt.Errorf("wingpt: partition %d name %q exceeds 36 UTF-16 code units", p.Number, p.Name)
		}
		for j, u := range units {
			binary.LittleEndian.PutUint16(buf[off+72+j*2:off+74+j*2], u)
		}
		// Remaining Name bytes (up to 72 bytes total) stay zero — NUL padding.
	}
	return buf, nil
}

// CopyUsableRange copies DRIVE_LAYOUT_INFORMATION_GPT's StartingUsableOffset,
// UsableLength and MaxPartitionCount (header bytes 24..44) from the disk's
// current raw layout into an EncodeDriveLayoutEx buffer.
func CopyUsableRange(dst, current []byte) error {
	if len(dst) < driveLayoutHeaderSize || len(current) < driveLayoutHeaderSize {
		return fmt.Errorf("wingpt: layout buffers too short (%d, %d bytes)", len(dst), len(current))
	}
	copy(dst[24:44], current[24:44])
	return nil
}

// EncodeCreateDiskGPT builds CREATE_DISK for IOCTL_DISK_CREATE_DISK, GPT
// variant, x64: PartitionStyle u32@0 (=1), CREATE_DISK_GPT.DiskId GUID@4,
// CREATE_DISK_GPT.MaxPartitionCount u32@20 (=128, the GPT minimum Windows
// itself uses), 24 bytes total.
func EncodeCreateDiskGPT(diskGUID string) ([]byte, error) {
	g, err := GUIDToBytes(diskGUID)
	if err != nil {
		return nil, fmt.Errorf("wingpt: disk GUID: %w", err)
	}
	buf := make([]byte, 24)
	binary.LittleEndian.PutUint32(buf[0:4], partitionStyleGPT)
	copy(buf[4:20], g[:])
	binary.LittleEndian.PutUint32(buf[20:24], 128)
	return buf, nil
}

// DecodeDriveLayoutEx parses an IOCTL_DISK_GET_DRIVE_LAYOUT_EX result buffer
// (GPT-style disks only — a caller must check PartitionStyle itself before
// calling this if MBR disks can reach it; W06a/W06b never provision MBR).
func DecodeDriveLayoutEx(b []byte) (Layout, error) {
	if len(b) < driveLayoutHeaderSize {
		return Layout{}, fmt.Errorf("wingpt: drive layout buffer too short (%d bytes)", len(b))
	}
	style := binary.LittleEndian.Uint32(b[0:4])
	if style != partitionStyleGPT {
		return Layout{}, fmt.Errorf("wingpt: partition style %d is not GPT", style)
	}
	count := binary.LittleEndian.Uint32(b[4:8])
	var diskGUIDBytes [16]byte
	copy(diskGUIDBytes[:], b[8:24])
	l := Layout{DiskGUID: BytesToGUID(diskGUIDBytes)}
	for i := uint32(0); i < count; i++ {
		off := driveLayoutHeaderSize + int(i)*partitionEntrySize
		if off+partitionEntrySize > len(b) {
			return Layout{}, fmt.Errorf("wingpt: drive layout buffer truncated at partition %d of %d", i, count)
		}
		var typeGUIDBytes, partGUIDBytes [16]byte
		copy(typeGUIDBytes[:], b[off+32:off+48])
		copy(partGUIDBytes[:], b[off+48:off+64])
		units := make([]uint16, 36)
		for j := range units {
			units[j] = binary.LittleEndian.Uint16(b[off+72+j*2 : off+74+j*2])
		}
		name := strings.TrimRight(string(utf16.Decode(units)), "\x00")
		l.Partitions = append(l.Partitions, Partition{
			Number:     int(binary.LittleEndian.Uint32(b[off+24 : off+28])),
			TypeGUID:   BytesToGUID(typeGUIDBytes),
			PartGUID:   BytesToGUID(partGUIDBytes),
			Name:       name,
			StartBytes: int64(binary.LittleEndian.Uint64(b[off+8 : off+16])),
			SizeBytes:  int64(binary.LittleEndian.Uint64(b[off+16 : off+24])),
			Attributes: binary.LittleEndian.Uint64(b[off+64 : off+72]),
		})
	}
	return l, nil
}
