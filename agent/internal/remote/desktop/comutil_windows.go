//go:build windows

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
// Uses a stack-allocated array for up to 4 args to avoid heap allocations in the hot path.
func comCall(obj uintptr, vtableIdx int, args ...uintptr) (uintptr, error) {
	vtablePtr := *(*uintptr)(unsafe.Pointer(obj))
	fnPtr := *(*uintptr)(unsafe.Pointer(vtablePtr + uintptr(vtableIdx)*unsafe.Sizeof(uintptr(0))))

	var ret uintptr
	switch len(args) {
	case 0:
		ret, _, _ = syscall.SyscallN(fnPtr, obj)
	case 1:
		ret, _, _ = syscall.SyscallN(fnPtr, obj, args[0])
	case 2:
		ret, _, _ = syscall.SyscallN(fnPtr, obj, args[0], args[1])
	case 3:
		ret, _, _ = syscall.SyscallN(fnPtr, obj, args[0], args[1], args[2])
	default:
		allArgs := make([]uintptr, 0, 1+len(args))
		allArgs = append(allArgs, obj)
		allArgs = append(allArgs, args...)
		ret, _, _ = syscall.SyscallN(fnPtr, allArgs...)
	}

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

	procMFStartup                = mfplatDLL.NewProc("MFStartup")
	procMFShutdown               = mfplatDLL.NewProc("MFShutdown")
	procMFTEnumEx                = mfplatDLL.NewProc("MFTEnumEx")
	procMFCreateMediaType        = mfplatDLL.NewProc("MFCreateMediaType")
	procMFCreateSample           = mfplatDLL.NewProc("MFCreateSample")
	procMFCreateMemoryBuffer     = mfplatDLL.NewProc("MFCreateMemoryBuffer")
	procMFCreateDXGIDeviceManager = mfplatDLL.NewProc("MFCreateDXGIDeviceManager")
	procMFCreateDXGISurfaceBuffer = mfplatDLL.NewProc("MFCreateDXGISurfaceBuffer")
)

// --- COM constants ---

const (
	coinitMultithreaded = 0x0

	mfVersion     = 0x00020070 // MF_VERSION (Windows 7+)
	mfStartupFull = 0

	// MFT_ENUM_FLAG
	mftEnumFlagSyncMFT       = 0x00000001
	mftEnumFlagHardware      = 0x00000004
	mftEnumFlagSortAndFilter = 0x00000040
	mftEnumFlagAll           = 0x0000003F

	// MFT_MESSAGE_TYPE
	mftMessageCommandFlush         = 0x00000000
	mftMessageNotifyBeginStreaming = 0x10000000
	mftMessageNotifyEndStreaming   = 0x10000001
	mftMessageNotifyStartOfStream  = 0x10000003

	// MFVideoInterlaceMode
	mfVideoInterlaceProgressive = 2

	// HRESULT codes
	eUnexpected              = 0x8000FFFF // E_UNEXPECTED
	mfENotAccepting          = 0xC00D36B5
	mfEBufferTooSmall        = 0xC00D36B1
	mfETransformNeedInput    = 0xC00D6D72
	mfETransformStreamChange = 0xC00D6D61

	// MFT_OUTPUT_DATA_BUFFER flags
	mftOutputDataBufferIncomplete = 0x01000000

	// MFT_OUTPUT_STREAM_INFO flags
	mftOutputStreamProvidesSamples = 0x00000100

	// MFT_MESSAGE_TYPE for D3D manager
	mftMessageSetD3DManager = 0x00000002

	// DXGI format for NV12 textures
	dxgiFormatNV12 = 103

	// D3D11 bind flags
	d3d11BindRenderTarget = 0x20
)

// mftRegisterTypeInfo matches MFT_REGISTER_TYPE_INFO.
type mftRegisterTypeInfo struct {
	guidMajorType comGUID
	guidSubtype   comGUID
}

// mftOutputDataBuffer matches MFT_OUTPUT_DATA_BUFFER.
type mftOutputDataBuffer struct {
	dwStreamID uint32
	pSample    uintptr
	dwStatus   uint32
	pEvents    uintptr
}

// mftOutputStreamInfo matches MFT_OUTPUT_STREAM_INFO.
type mftOutputStreamInfo struct {
	dwFlags     uint32
	cbSize      uint32
	cbAlignment uint32
}

// --- GUIDs ---

var (
	mftCategoryVideoEncoder = comGUID{0xf79eac7d, 0xe545, 0x4387, [8]byte{0xbd, 0xee, 0xd6, 0x47, 0xd7, 0xbd, 0xe4, 0x2a}}
	iidIMFTransform         = comGUID{0xbf94c121, 0x5b05, 0x4e6f, [8]byte{0x80, 0x00, 0xba, 0x59, 0x89, 0x61, 0x41, 0x4d}}

	mfMediaTypeVideo  = comGUID{0x73646976, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatH264 = comGUID{0x34363248, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}
	mfVideoFormatNV12 = comGUID{0x3231564E, 0x0000, 0x0010, [8]byte{0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}}

	mfMTMajorType        = comGUID{0x48eba18e, 0xf8c9, 0x4687, [8]byte{0xbf, 0x11, 0x0a, 0x74, 0xc9, 0xf9, 0x6a, 0x8f}}
	mfMTSubtype          = comGUID{0xf7e34c9a, 0x42e8, 0x4714, [8]byte{0xb7, 0x4b, 0xcb, 0x29, 0xd7, 0x2c, 0x35, 0xe5}}
	mfMTAvgBitrate       = comGUID{0x20332624, 0xfb0d, 0x4d9e, [8]byte{0xbd, 0x0d, 0xcb, 0xf6, 0x78, 0x6c, 0x10, 0x2e}}
	mfMTInterlaceMode    = comGUID{0xe2724bb8, 0xe676, 0x4806, [8]byte{0xb4, 0xb2, 0xa8, 0xd6, 0xef, 0xb4, 0x4c, 0xcd}}
	mfMTFrameSize        = comGUID{0x1652c33d, 0xd6b2, 0x4012, [8]byte{0xb8, 0x34, 0x72, 0x03, 0x08, 0x49, 0xa3, 0x7d}}
	mfMTFrameRate        = comGUID{0xc459a2e8, 0x3d2c, 0x4e44, [8]byte{0xb1, 0x32, 0xfe, 0xe5, 0x15, 0x6c, 0x7b, 0xb0}}
	mfMTPixelAspectRatio = comGUID{0xc6376a1e, 0x8d0a, 0x4027, [8]byte{0xbe, 0x45, 0x6d, 0x9a, 0x0a, 0xd3, 0x9b, 0xb6}}
	mfLowLatency         = comGUID{0x9c27891a, 0xed7a, 0x40e1, [8]byte{0x88, 0xe8, 0xb2, 0x27, 0x27, 0xa0, 0x24, 0xee}}
	mfMTDefaultStride    = comGUID{0x644b4e48, 0x1e02, 0x4516, [8]byte{0xb0, 0xeb, 0xc0, 0x1c, 0xa9, 0xd4, 0x9a, 0xc6}}
	mfMTMpeg2Profile     = comGUID{0xad76a80b, 0x2d5c, 0x4e0b, [8]byte{0xb3, 0x75, 0x64, 0xe5, 0x20, 0x13, 0x70, 0x36}}

	// Async MFT unlock — required before configuring hardware encoders
	mfTransformAsyncUnlock = comGUID{0xe5666d6b, 0x3422, 0x4eb6, [8]byte{0xa4, 0x21, 0xda, 0x7d, 0xb1, 0xf8, 0xe2, 0x07}}

	// D3D11 Video interfaces for GPU color conversion
	iidID3D11VideoDevice  = comGUID{0x10ec4d5b, 0x975a, 0x4689, [8]byte{0xb9, 0xe4, 0xd0, 0xaa, 0xc3, 0x0f, 0xe3, 0x33}}
	iidID3D11VideoContext = comGUID{0x61f21c45, 0x3c0e, 0x4a74, [8]byte{0x9c, 0xea, 0x67, 0x10, 0x0d, 0x9a, 0xd5, 0xe4}}

	// MF_SA_D3D11_AWARE — set to TRUE on MFT attributes for DXGI-aware encoding
	mfSAD3D11Aware = comGUID{0x206b4fc8, 0xfcf9, 0x4c51, [8]byte{0xaf, 0xe3, 0x97, 0x64, 0x36, 0x9e, 0x33, 0xa0}}

	// ICodecAPI — for dynamic bitrate changes on live encoder
	iidICodecAPI               = comGUID{0x901db4c7, 0x31ce, 0x41a2, [8]byte{0x85, 0xdc, 0x8f, 0xa0, 0xbf, 0x41, 0xb8, 0xda}}
	codecAPIAVEncCommonMeanBitRate  = comGUID{0xf7222374, 0x2144, 0x4815, [8]byte{0xb5, 0x50, 0xa3, 0x7f, 0x8e, 0x12, 0xee, 0x52}}
	codecAPIAVEncVideoForceKeyFrame = comGUID{0x398c1b98, 0x8353, 0x475a, [8]byte{0x9e, 0xf2, 0x8f, 0x26, 0x5d, 0x26, 0x03, 0x45}}
	codecAPIAVEncMPVGOPSize         = comGUID{0x95f31b26, 0x95a4, 0x41d0, [8]byte{0xa3, 0xc4, 0x99, 0xd7, 0xe2, 0xb7, 0xeb, 0xe7}}

	// H264 profile constants
	eAVEncH264VProfileBaseline uint32 = 66
	eAVEncH264VProfileMain     uint32 = 77

	// HRESULT for async locked
	mfETransformAsyncLocked = 0xC00D6D77
)

// --- vtable index constants ---
//
// These are fixed by the COM ABI and must be exact.
// IUnknown:        0=QueryInterface, 1=AddRef, 2=Release
// IMFAttributes:   starts at 3 (30 methods)
// IMFMediaType:    extends IMFAttributes (5 more methods starting at 33)
// IMFSample:       extends IMFAttributes (14 more methods starting at 33)
// IMFMediaBuffer:  starts at 3 (5 methods)
// IMFTransform:    starts at 3 (23 methods)

const (
	// IMFAttributes vtable offsets (base 3 + method index)
	vtblSetUINT32 = 21 // 3 + 18
	vtblSetUINT64 = 22 // 3 + 19
	vtblSetGUID   = 24 // 3 + 21

	// IMFTransform vtable offsets (base 3 + method index)
	vtblGetOutputStreamInfo = 7  // 3 + 4
	vtblGetAttributes       = 8  // 3 + 5
	vtblGetOutputAvailType  = 14 // 3 + 11
	vtblSetInputType        = 15 // 3 + 12
	vtblSetOutputType       = 16 // 3 + 13
	vtblProcessMessage      = 23 // 3 + 20
	vtblProcessInput        = 24 // 3 + 21
	vtblProcessOutput       = 25 // 3 + 22

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

	// IUnknown vtable offsets
	vtblQueryInterface = 0

	// ICodecAPI vtable offsets (extends IUnknown)
	vtblCodecAPISetValue = 9 // 3(IUnknown) + 6(IsSupported..GetValue) + 0

	// ID3D11VideoDevice vtable offsets (IUnknown base 0-2, then methods)
	// 3=CreateVideoDecoder, 4=CreateVideoProcessor, 5=CreateAuthenticatedChannel,
	// 6=CreateCryptoSession, 7=CreateVideoDecoderOutputView,
	// 8=CreateVideoProcessorInputView, 9=CreateVideoProcessorOutputView,
	// 10=CreateVideoProcessorEnumerator
	vtblVidDevCreateVideoProcessor           = 4
	vtblVidDevCreateVideoProcessorEnumerator = 10
	vtblVidDevCreateVideoProcessorInputView  = 8
	vtblVidDevCreateVideoProcessorOutputView = 9

	// ID3D11VideoContext vtable offsets (IUnknown 0-2, ID3D11DeviceChild 3-6,
	// then: 7-12=decoder methods (GetDecoderBuffer..DecoderExtension),
	// 13-19=output set methods (+Extension at 19),
	// 20-26=output get methods (+Extension at 26),
	// 27-39=stream set methods (13), 40-52=stream get methods (13),
	// 53=VideoProcessorBlt)
	vtblVidCtxVideoProcessorSetOutputColorSpace = 15
	vtblVidCtxVideoProcessorSetStreamColorSpace = 28
	vtblVidCtxVideoProcessorBlt                 = 53

	// IMFDXGIDeviceManager vtable offsets (IUnknown base = 3)
	vtblDXGIManagerResetDevice = 7
)

// comVariant matches the Windows VARIANT struct (16 bytes on x64).
// Used for ICodecAPI::SetValue calls.
type comVariant struct {
	vt       uint16   // VARTYPE
	reserved [6]byte  // wReserved1-3
	val      uint64   // union (holds ULONG for VT_UI4)
}

const vtUI4 = 19 // VT_UI4

// d3d11VideoProcessorContentDesc matches D3D11_VIDEO_PROCESSOR_CONTENT_DESC.
type d3d11VideoProcessorContentDesc struct {
	InputFrameFormat uint32 // 0 = PROGRESSIVE
	InputFrameRateN  uint32
	InputFrameRateD  uint32
	InputWidth       uint32
	InputHeight      uint32
	OutputFrameRateN uint32
	OutputFrameRateD uint32
	OutputWidth      uint32
	OutputHeight     uint32
	Usage            uint32 // 0 = PLAYBACK_NORMAL
}

// d3d11VideoProcessorStream matches D3D11_VIDEO_PROCESSOR_STREAM.
type d3d11VideoProcessorStream struct {
	Enable                int32
	OutputIndex           uint32
	InputFrameOrField     uint32
	PastFrames            uint32
	FutureFrames          uint32
	PPastSurfaces         uintptr
	PInputSurface         uintptr // ID3D11VideoProcessorInputView
	PPFutureSurfaces      uintptr
	PPPastSurfacesRight   uintptr
	PInputSurfaceRight    uintptr
	PPFutureSurfacesRight uintptr
}

// pack64 packs two uint32 values into a single uint64 (high << 32 | low).
func pack64(high, low uint32) uint64 {
	return uint64(high)<<32 | uint64(low)
}
