//go:build windows

package desktop

import (
	"fmt"
	"unsafe"
)

// =============================================================================
// NVIDIA Video Codec SDK 12.2 — Type Definitions for NVENC API
//
// Struct layouts match nvEncodeAPI.h from the nv-codec-headers project
// (tag n12.2.72.0). All reserved field sizes are verified against the SDK
// header sizeof values. Wrong sizes cause NV_ENC_ERR_INVALID_VERSION at
// runtime or memory corruption — the init() assertions catch mismatches.
// =============================================================================

// --- Version macros ---

const (
	nvencAPIMajor   = 12
	nvencAPIMinor   = 2
	nvencAPIVersion = nvencAPIMajor | (nvencAPIMinor << 24) // 0x0200000C
)

// nvencStructVer computes the version field for standard NVENC structs.
func nvencStructVer(v uint32) uint32 {
	return uint32(nvencAPIVersion) | (v << 16) | (0x7 << 28)
}

// nvencStructVerExt computes the version field for structs that contain
// versioned sub-structs (CONFIG, INITIALIZE_PARAMS, PIC_PARAMS, etc.).
func nvencStructVerExt(v uint32) uint32 {
	return nvencStructVer(v) | (1 << 31)
}

// --- GUID type ---

type nvencGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

// --- Codec, preset, and profile GUIDs ---

var (
	nvencCodecH264GUID = nvencGUID{
		0x6bc82762, 0x4e63, 0x4ca4,
		[8]byte{0xaa, 0x85, 0x1e, 0x50, 0xf3, 0x21, 0xf6, 0xbf},
	}
	nvencPresetP1GUID = nvencGUID{ // fastest / lowest quality
		0xfc0a8d3e, 0x45f8, 0x4cf8,
		[8]byte{0x80, 0xc7, 0x29, 0x88, 0x71, 0x59, 0x0e, 0xbf},
	}
	nvencPresetP4GUID = nvencGUID{ // balanced quality/performance
		0x90a7b826, 0xdf06, 0x4862,
		[8]byte{0xb9, 0xd2, 0xcd, 0x6d, 0x73, 0xa0, 0x86, 0x81},
	}
	nvencH264HighGUID = nvencGUID{
		0xe7cbc309, 0x4f7a, 0x4b89,
		[8]byte{0xaf, 0x2a, 0xd5, 0x37, 0xc9, 0x2b, 0xe3, 0x10},
	}
	nvencProfileAutoGUID = nvencGUID{
		0xbfd6f8e7, 0x233c, 0x4341,
		[8]byte{0x8b, 0x3e, 0x48, 0x18, 0x52, 0x38, 0x03, 0xf4},
	}
)

// --- Constants ---

const (
	// Device and resource types
	nvencDeviceTypeDX    uint32 = 0 // NV_ENC_DEVICE_TYPE_DIRECTX
	nvencInputResDX      uint32 = 0 // NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX
	nvencBufFmtARGB      uint32 = 0x01000000
	nvencBufFmtNV12      uint32 = 0x00000001
	nvencBufUsageInput   uint32 = 0 // NV_ENC_INPUT_IMAGE

	// Rate control
	nvencRCConstQP uint32 = 0
	nvencRCVBR     uint32 = 1
	nvencRCCBR     uint32 = 2

	// Picture flags
	nvencPicFlagForceIntra uint32 = 1
	nvencPicFlagForceIDR   uint32 = 2
	nvencPicFlagSPSPPS     uint32 = 4
	nvencPicFlagEOS        uint32 = 8

	// Picture struct
	nvencPicStructFrame uint32 = 1

	// Tuning info
	nvencTuningUndef         uint32 = 0
	nvencTuningHighQuality   uint32 = 1
	nvencTuningLowLatency    uint32 = 2
	nvencTuningUltraLowLat   uint32 = 3
	nvencTuningLossless      uint32 = 4

	// Status codes
	nvencSuccess                   = 0
	nvencErrNoEncodeDevice         = 1
	nvencErrUnsupportedDevice      = 2
	nvencErrInvalidEncoderDevice   = 3
	nvencErrInvalidDevice          = 4
	nvencErrDeviceNotExist         = 5
	nvencErrInvalidPtr             = 6
	nvencErrInvalidParam           = 8
	nvencErrInvalidCall            = 9
	nvencErrOutOfMemory            = 10
	nvencErrEncoderNotInitialized  = 11
	nvencErrUnsupportedParam       = 12
	nvencErrLockBusy               = 13
	nvencErrNotEnoughBuffer        = 14
	nvencErrInvalidVersion         = 15
	nvencErrMapFailed              = 16
	nvencErrNeedMoreInput          = 17
	nvencErrEncoderBusy            = 18
	nvencErrGeneric                = 20

	nvencInfiniteGOP uint32 = 0xffffffff
)

func nvencStatusStr(code uintptr) string {
	names := map[uintptr]string{
		0: "SUCCESS", 1: "NO_ENCODE_DEVICE", 2: "UNSUPPORTED_DEVICE",
		3: "INVALID_ENCODERDEVICE", 4: "INVALID_DEVICE", 5: "DEVICE_NOT_EXIST",
		6: "INVALID_PTR", 7: "INVALID_EVENT", 8: "INVALID_PARAM",
		9: "INVALID_CALL", 10: "OUT_OF_MEMORY", 11: "ENCODER_NOT_INITIALIZED",
		12: "UNSUPPORTED_PARAM", 13: "LOCK_BUSY", 14: "NOT_ENOUGH_BUFFER",
		15: "INVALID_VERSION", 16: "MAP_FAILED", 17: "NEED_MORE_INPUT",
		18: "ENCODER_BUSY", 20: "GENERIC",
	}
	if s, ok := names[code]; ok {
		return s
	}
	return fmt.Sprintf("UNKNOWN(%d)", code)
}

// =============================================================================
// NV_ENCODE_API_FUNCTION_LIST — 2552 bytes
// Filled by NvEncodeAPICreateInstance. Field order matches nvEncodeAPI.h.
// =============================================================================

type nvencFuncList struct {
	Version  uint32
	_pad     uint32
	// Function pointers — indices [0] through [42]
	OpenEncodeSession         uintptr // [0] deprecated
	GetEncodeGUIDCount        uintptr // [1]
	GetEncodeProfileGUIDCount uintptr // [2]
	GetEncodeProfileGUIDs     uintptr // [3]
	GetEncodeGUIDs            uintptr // [4]
	GetInputFormatCount       uintptr // [5]
	GetInputFormats           uintptr // [6]
	GetEncodeCaps             uintptr // [7]
	GetEncodePresetCount      uintptr // [8]
	GetEncodePresetGUIDs      uintptr // [9]
	GetEncodePresetConfig     uintptr // [10]
	InitializeEncoder         uintptr // [11]
	CreateInputBuffer         uintptr // [12]
	DestroyInputBuffer        uintptr // [13]
	CreateBitstreamBuffer     uintptr // [14]
	DestroyBitstreamBuffer    uintptr // [15]
	EncodePicture             uintptr // [16]
	LockBitstream             uintptr // [17]
	UnlockBitstream           uintptr // [18]
	LockInputBuffer           uintptr // [19]
	UnlockInputBuffer         uintptr // [20]
	GetEncodeStats            uintptr // [21]
	GetSequenceParams         uintptr // [22]
	RegisterAsyncEvent        uintptr // [23]
	UnregisterAsyncEvent      uintptr // [24]
	MapInputResource          uintptr // [25]
	UnmapInputResource        uintptr // [26]
	DestroyEncoder            uintptr // [27]
	InvalidateRefFrames       uintptr // [28]
	OpenEncodeSessionEx       uintptr // [29]
	RegisterResource          uintptr // [30]
	UnregisterResource        uintptr // [31]
	ReconfigureEncoder        uintptr // [32]
	_reserved1                uintptr // [33]
	CreateMVBuffer            uintptr // [34]
	DestroyMVBuffer           uintptr // [35]
	RunMotionEstimation       uintptr // [36]
	GetLastErrorString        uintptr // [37]
	SetIOCudaStreams          uintptr // [38]
	GetPresetConfigEx         uintptr // [39]
	GetSequenceParamEx        uintptr // [40]
	RestoreEncoderState       uintptr // [41]
	LookaheadPicture          uintptr // [42]
	_reserved2                [275]uintptr
}

// =============================================================================
// Session and resource structs
// =============================================================================

// NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS — 1552 bytes
type nvencOpenSessionParams struct {
	Version    uint32
	DeviceType uint32
	Device     uintptr
	_reserved  uintptr
	APIVersion uint32
	_res1      [253]uint32
	_res2      [64]uintptr
}

// NV_ENC_CREATE_BITSTREAM_BUFFER — 776 bytes
type nvencCreateBitstreamBuffer struct {
	Version   uint32
	_size     uint32  // deprecated
	_memHeap  uint32  // deprecated
	_res0     uint32
	Buffer    uintptr // out: handle for LockBitstream/EncodePicture
	_bufPtr   uintptr // out, reserved
	_res1     [58]uint32
	_res2     [64]uintptr
}

// NV_ENC_REGISTER_RESOURCE — 1536 bytes
type nvencRegisterResource struct {
	Version    uint32
	ResType    uint32
	Width      uint32
	Height     uint32
	Pitch      uint32
	SubResIdx  uint32
	Resource   uintptr // in: ID3D11Texture2D*
	Registered uintptr // out: handle for MapInputResource
	BufFormat  uint32
	BufUsage   uint32
	_fence     uintptr
	_chroma    [2]uint32
	_res1      [246]uint32
	_res2      [61]uintptr
}

// NV_ENC_MAP_INPUT_RESOURCE — 1544 bytes
type nvencMapInputResource struct {
	Version    uint32
	_subRes    uint32  // deprecated
	_inputRes  uintptr // deprecated
	Registered uintptr // in: from RegisterResource
	Mapped     uintptr // out: for EncodePicture
	MappedFmt  uint32  // out
	_res1      [251]uint32
	_res2      [63]uintptr
}

// NV_ENC_LOCK_BITSTREAM — 1544 bytes
type nvencLockBitstream struct {
	Version        uint32
	Flags          uint32  // bitfield: doNotWait(0), ltrFrame(1), getRCStats(2)
	OutputBitstream uintptr // in: bitstream buffer handle
	_sliceOffsets  uintptr
	FrameIdx       uint32  // out
	HWEncodeStatus uint32  // out
	NumSlices      uint32  // out
	BitstreamSize  uint32  // out: byte count
	OutputTS       uint64  // out
	OutputDur      uint64  // out
	DataPtr        uintptr // out: pointer to compressed H264 data
	PictureType    uint32  // out
	PictureStruct  uint32  // out
	FrameAvgQP     uint32  // out
	_rest          [1468]byte
}

// NV_ENC_PIC_PARAMS — 2840 bytes
type nvencPicParams struct {
	Version         uint32
	InputWidth      uint32
	InputHeight     uint32
	InputPitch      uint32
	EncodePicFlags  uint32
	FrameIdx        uint32
	InputTimeStamp  uint64
	InputDuration   uint64
	InputBuffer     uintptr // mapped resource handle
	OutputBitstream uintptr // bitstream buffer handle
	CompletionEvent uintptr
	BufferFmt       uint32
	PictureStruct   uint32
	PictureType     uint32
	_rest           [2764]byte
}

// NV_ENC_INITIALIZE_PARAMS — 1800 bytes
type nvencInitParams struct {
	Version      uint32
	EncodeGUID   nvencGUID
	PresetGUID   nvencGUID
	EncodeWidth  uint32
	EncodeHeight uint32
	DarWidth     uint32
	DarHeight    uint32
	FrameRateNum uint32
	FrameRateDen uint32
	EnableAsync  uint32
	EnablePTD    uint32
	_bitfields   uint32
	_privSz      uint32
	_res0        uint32
	_privData    uintptr
	EncodeConfig uintptr // pointer to nvencConfig
	MaxEncWidth  uint32
	MaxEncHeight uint32
	_meHints     [32]byte
	TuningInfo   uint32
	_bufFmt      uint32
	_numState    uint32
	_statsLvl    uint32
	_res1        [284]uint32
	_res2        [64]uintptr
}

// =============================================================================
// NV_ENC_CONFIG — 3584 bytes (opaque byte array with field accessors)
//
// This struct has deeply nested unions (NV_ENC_CODEC_CONFIG with H264/HEVC/AV1
// sub-configs) and hundreds of fields. We treat it as a byte array and access
// only the fields we need via offset helpers. The preset API fills it with
// sensible defaults; we modify only the fields required for ultra-low-latency.
// =============================================================================

type nvencConfig [3584]byte

// NV_ENC_PRESET_CONFIG — 5128 bytes
// Layout: version(4) + reserved(4) + NV_ENC_CONFIG(3584) + reserved(1024+512)
type nvencPresetConfig [5128]byte

// Field offsets within nvencConfig
const (
	ncfgVersion        = 0
	ncfgProfileGUID    = 4   // GUID, 16 bytes
	ncfgGOPLength      = 20  // uint32
	ncfgFrameIntervalP = 24  // int32
	// rcParams starts at offset 40 (NV_ENC_RC_PARAMS, 128 bytes)
	ncfgRCVersion  = 40 // uint32 (rcParams.version)
	ncfgRCMode     = 44 // uint32 (rcParams.rateControlMode)
	ncfgRCAvgBR    = 60 // uint32 (rcParams.averageBitRate)
	ncfgRCMaxBR    = 64 // uint32 (rcParams.maxBitRate)
	ncfgRCVBVBuf   = 68 // uint32 (rcParams.vbvBufferSize)
	ncfgRCVBVInit  = 72 // uint32 (rcParams.vbvInitialDelay)
	// encodeCodecConfig (union) starts at offset 168
	// For H264: NV_ENC_CONFIG_H264 fields
	ncfgH264Bitfields  = 168 // uint32 bitfield
	ncfgH264Level      = 172 // uint32
	ncfgH264IDRPeriod  = 176 // uint32
	ncfgH264MaxRefFrm  = 228 // uint32
	ncfgH264SliceMode  = 232 // uint32
	ncfgH264SliceData  = 236 // uint32
	ncfgH264Entropy    = 212 // uint32 (NV_ENC_H264_ENTROPY_CODING_MODE)
)

// H264 config bitfield flags (at ncfgH264Bitfields)
const (
	ncfgH264RepeatSPSPPS uint32 = 1 << 12
)

// Accessors for nvencConfig fields
func ncfgPutU32(c *nvencConfig, off int, v uint32) {
	*(*uint32)(unsafe.Pointer(&c[off])) = v
}

func ncfgGetU32(c *nvencConfig, off int) uint32 {
	return *(*uint32)(unsafe.Pointer(&c[off]))
}

func ncfgPutGUID(c *nvencConfig, off int, g nvencGUID) {
	*(*nvencGUID)(unsafe.Pointer(&c[off])) = g
}

// =============================================================================
// Compile-time struct size assertions
// =============================================================================

func init() {
	assertSize := func(name string, got, want uintptr) {
		if got != want {
			panic(fmt.Sprintf("nvenc: %s size %d, expected %d — struct layout mismatch with SDK", name, got, want))
		}
	}
	assertSize("nvencGUID", unsafe.Sizeof(nvencGUID{}), 16)
	assertSize("nvencFuncList", unsafe.Sizeof(nvencFuncList{}), 2552)
	assertSize("nvencOpenSessionParams", unsafe.Sizeof(nvencOpenSessionParams{}), 1552)
	assertSize("nvencCreateBitstreamBuffer", unsafe.Sizeof(nvencCreateBitstreamBuffer{}), 776)
	assertSize("nvencRegisterResource", unsafe.Sizeof(nvencRegisterResource{}), 1536)
	assertSize("nvencMapInputResource", unsafe.Sizeof(nvencMapInputResource{}), 1544)
	assertSize("nvencLockBitstream", unsafe.Sizeof(nvencLockBitstream{}), 1544)
	assertSize("nvencPicParams", unsafe.Sizeof(nvencPicParams{}), 2840)
	assertSize("nvencInitParams", unsafe.Sizeof(nvencInitParams{}), 1800)
	assertSize("nvencConfig", unsafe.Sizeof(nvencConfig{}), 3584)
	assertSize("nvencPresetConfig", unsafe.Sizeof(nvencPresetConfig{}), 5128)
}
