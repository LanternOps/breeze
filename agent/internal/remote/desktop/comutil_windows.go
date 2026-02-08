//go:build windows && !cgo

package desktop

import (
	"fmt"
	"syscall"
	"unsafe"
)

// COM vtable calling infrastructure for Windows Media Foundation.
// Follows the same pure-Go syscall pattern as capture_windows_nocgo.go.

// comGUID is a COM GUID (128-bit).
type comGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// comCall invokes a COM vtable method at the given index.
// obj is a pointer to a COM interface (pointer to pointer to vtable).
func comCall(obj uintptr, vtableIdx int, args ...uintptr) (uintptr, error) {
	vtablePtr := *(*uintptr)(unsafe.Pointer(obj))
	fnPtr := *(*uintptr)(unsafe.Pointer(vtablePtr + uintptr(vtableIdx)*unsafe.Sizeof(uintptr(0))))
	allArgs := make([]uintptr, 0, 1+len(args))
	allArgs = append(allArgs, obj)
	allArgs = append(allArgs, args...)
	ret, _, _ := syscall.SyscallN(fnPtr, allArgs...)
	if int32(ret) < 0 {
		return ret, fmt.Errorf("COM vtable[%d] HRESULT 0x%08X", vtableIdx, uint32(ret))
	}
	return ret, nil
}

// comRelease calls IUnknown::Release (vtable index 2).
func comRelease(obj uintptr) {
	if obj != 0 {
		vtablePtr := *(*uintptr)(unsafe.Pointer(obj))
		fnPtr := *(*uintptr)(unsafe.Pointer(vtablePtr + 2*unsafe.Sizeof(uintptr(0))))
		syscall.SyscallN(fnPtr, obj)
	}
}

// --- DLL procs ---

var (
	ole32DLL  = syscall.NewLazyDLL("ole32.dll")
	mfplatDLL = syscall.NewLazyDLL("mfplat.dll")

	procCoInitializeEx = ole32DLL.NewProc("CoInitializeEx")
	procCoUninitialize = ole32DLL.NewProc("CoUninitialize")
	procCoTaskMemFree  = ole32DLL.NewProc("CoTaskMemFree")

	procMFStartup            = mfplatDLL.NewProc("MFStartup")
	procMFShutdown           = mfplatDLL.NewProc("MFShutdown")
	procMFTEnumEx            = mfplatDLL.NewProc("MFTEnumEx")
	procMFCreateMediaType    = mfplatDLL.NewProc("MFCreateMediaType")
	procMFCreateSample       = mfplatDLL.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer = mfplatDLL.NewProc("MFCreateMemoryBuffer")
)

// --- COM constants ---

const (
	coinitMultithreaded = 0x0

	mfVersion     = 0x00020070 // MF_VERSION (Windows 7+)
	mfStartupFull = 0

	// MFT_ENUM_FLAG
	mftEnumFlagSyncMFT        = 0x00000001
	mftEnumFlagHardware       = 0x00000004
	mftEnumFlagSortAndFilter  = 0x00000040
	mftEnumFlagAll            = 0x0000003F

	// MFT_MESSAGE_TYPE
	mftMessageCommandFlush          = 0x00000000
	mftMessageNotifyBeginStreaming   = 0x10000000
	mftMessageNotifyEndStreaming     = 0x10000001
	mftMessageNotifyStartOfStream   = 0x10000003

	// MFVideoInterlaceMode
	mfVideoInterlaceProgressive = 2

	// HRESULT codes
	mfENotAccepting       = 0xC00D36B5
	mfETransformNeedInput = 0xC00D6D72

	// MFT_OUTPUT_DATA_BUFFER flags
	mftOutputDataBufferIncomplete = 0x01000000
)

// mftRegisterTypeInfo matches MFT_REGISTER_TYPE_INFO.
type mftRegisterTypeInfo struct {
	guidMajorType comGUID
	guidSubtype   comGUID
}

// mftOutputDataBuffer matches MFT_OUTPUT_DATA_BUFFER.
type mftOutputDataBuffer struct {
	dwStreamID    uint32
	pSample       uintptr
	dwStatus      uint32
	pEvents       uintptr
}

// --- GUIDs ---

var (
	mftCategoryVideoEncoder = comGUID{0xf79eac7d, 0xe545, 0x4387, [8]byte{0xbd, 0xee, 0xd6, 0x47, 0xd7, 0xbd, 0xe4, 0x2a}}
	iidIMFTransform         = comGUID{0xbf94c121, 0x5b05, 0x4e6f, [8]byte{0x80, 0x00, 0xba, 0x59, 0x89, 0x61, 0x41, 0x4d}}

	mfMediaTypeVideo   = comGUID{0x73646976, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatH264  = comGUID{0x34363248, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatNV12  = comGUID{0x3231564E, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}

	mfMTMajorType         = comGUID{0x48eba18e, 0xf8c9, 0x4687, [8]byte{0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f}}
	mfMTSubtype           = comGUID{0xf7e34c9a, 0x42e8, 0x4714, [8]byte{0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5}}
	mfMTAvgBitrate        = comGUID{0x20332624, 0xfb0d, 0x4d9e, [8]byte{0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e}}
	mfMTInterlaceMode     = comGUID{0xe2724bb8, 0xe676, 0x4806, [8]byte{0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd}}
	mfMTFrameSize         = comGUID{0x1652c33d, 0xd6b2, 0x4012, [8]byte{0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d}}
	mfMTFrameRate         = comGUID{0xc459a2e8, 0x3d2c, 0x4e44, [8]byte{0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0}}
	mfMTPixelAspectRatio  = comGUID{0xc6376a1e, 0x8d0a, 0x4027, [8]byte{0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6}}
	mfLowLatency          = comGUID{0x9c27891a, 0xed7a, 0x40e1, [8]byte{0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee}}
)

// --- vtable index constants ---
//
// These are fixed by the COM ABI and must be exact.
// IUnknown:        0=QueryInterface, 1=AddRef, 2=Release
// IMFAttributes:   starts at 3 (30 methods)
// IMFMediaType:    extends IMFAttributes (5 more methods starting at 33)
// IMFSample:       extends IMFAttributes (14 more methods starting at 33)
// IMFMediaBuffer:  starts at 3 (5 methods)
// IMFTransform:    starts at 3 (20 methods)

const (
	// IMFAttributes vtable offsets (base 3 + method index)
	vtblSetUINT32 = 21 // 3 + 18
	vtblSetUINT64 = 22 // 3 + 19
	vtblSetGUID   = 24 // 3 + 21

	// IMFTransform vtable offsets (base 3 + method index)
	vtblGetOutputStreamInfo = 7  // 3 + 4
	vtblGetAttributes       = 8  // 3 + 5
	vtblSetInputType        = 15 // 3 + 12
	vtblSetOutputType       = 16 // 3 + 13
	vtblProcessMessage      = 20 // 3 + 17
	vtblProcessInput        = 21 // 3 + 18
	vtblProcessOutput       = 22 // 3 + 19

	// IMFSample vtable offsets (extends IMFAttributes, base 33 + method index)
	vtblSetSampleTime       = 36 // 33 + 3
	vtblSetSampleDuration   = 38 // 33 + 5
	vtblAddBuffer           = 42 // 33 + 9
	vtblConvertToContiguous = 41 // 33 + 8
	vtblGetTotalLength      = 45 // 33 + 12

	// IMFMediaBuffer vtable offsets (base 3 + method index)
	vtblBufLock             = 3
	vtblBufUnlock           = 4
	vtblBufGetCurrentLength = 5
	vtblBufSetCurrentLength = 6

	// IMFActivate vtable offset for ActivateObject (extends IMFAttributes)
	vtblActivateObject = 33 // 33 + 0
)

// pack64 packs two uint32 values into a single uint64 (high << 32 | low).
func pack64(high, low uint32) uint64 {
	return uint64(high)<<32 | uint64(low)
}
