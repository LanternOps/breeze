//go:build windows

package desktop

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// =============================================================================
// AMD Advanced Media Framework (AMF) 1.4 — Type Definitions
//
// AMF uses COM-style vtable interfaces. Each object is a pointer to a vtable
// pointer. Methods are called by indexing into the vtable and using
// syscall.SyscallN with the object pointer as the first argument.
//
// References: https://github.com/GPUOpen-LibrariesAndSDKs/AMF
//   amf/public/include/core/Factory.h, Context.h, Data.h, Surface.h
//   amf/public/include/components/VideoEncoderVCE.h
// =============================================================================

// --- AMF Version ---

const amfVersion14 uint64 = (1 << 48) | (4 << 32) // 1.4.0.0

// --- AMF Result Codes ---

const (
	amfOK             = 0
	amfFail           = 1
	amfAccessDenied   = 3
	amfInvalidArg     = 4
	amfOutOfMemory    = 6
	amfNotSupported   = 10
	amfNotFound       = 11
	amfNotInitialized = 13
	amfNoDevice       = 17
	amfDXFailed       = 18
	amfEOF            = 23
	amfRepeat         = 24
	amfInputFull      = 25
	amfNeedMoreInput  = 43
)

func amfResultStr(code uintptr) string {
	names := map[uintptr]string{
		0: "OK", 1: "FAIL", 3: "ACCESS_DENIED", 4: "INVALID_ARG",
		6: "OUT_OF_MEMORY", 10: "NOT_SUPPORTED", 11: "NOT_FOUND",
		13: "NOT_INITIALIZED", 17: "NO_DEVICE", 18: "DX_FAILED",
		23: "EOF", 24: "REPEAT", 25: "INPUT_FULL", 43: "NEED_MORE_INPUT",
	}
	if s, ok := names[code]; ok {
		return s
	}
	return fmt.Sprintf("AMF_ERR(%d)", code)
}

// --- AMF Memory Types ---

const (
	amfMemoryUnknown = 0
	amfMemoryHost    = 1
	amfMemoryDX9     = 2
	amfMemoryDX11    = 3
)

// --- AMF Surface Formats ---

const (
	amfSurfaceUnknown = 0
	amfSurfaceNV12    = 1
	amfSurfaceBGRA    = 3
	amfSurfaceRGBA    = 5
)

// --- AMF DX Version ---

const (
	amfDX11_0 = 110
	amfDX11_1 = 111
)

// --- AMF Variant Types ---

const (
	amfVarEmpty  = 0
	amfVarBool   = 1
	amfVarInt64  = 2
	amfVarDouble = 3
	amfVarString = 5
	amfVarSize   = 6
	amfVarRate   = 7
)

// amfVariant matches AMFVariantStruct (24 bytes on 64-bit).
// Layout: type(4) + pad(4) + value union(16)
type amfVariant struct {
	VarType int32
	_pad    int32
	Value   [16]byte // union: int64, bool, double, AMFSize, AMFRate, etc.
}

func amfVariantInt64(v int64) amfVariant {
	var vt amfVariant
	vt.VarType = amfVarInt64
	*(*int64)(unsafe.Pointer(&vt.Value[0])) = v
	return vt
}

func amfVariantBool(v bool) amfVariant {
	var vt amfVariant
	vt.VarType = amfVarBool
	if v {
		*(*int32)(unsafe.Pointer(&vt.Value[0])) = 1
	}
	return vt
}

// amfVariantRate sets an AMFRate value (num/den, each uint32).
func amfVariantRate(num, den uint32) amfVariant {
	var vt amfVariant
	vt.VarType = amfVarRate
	*(*uint32)(unsafe.Pointer(&vt.Value[0])) = num
	*(*uint32)(unsafe.Pointer(&vt.Value[4])) = den
	return vt
}

// amfVariantSize sets an AMFSize value (width/height, each int32).
func amfVariantSize(w, h int32) amfVariant {
	var vt amfVariant
	vt.VarType = amfVarSize
	*(*int32)(unsafe.Pointer(&vt.Value[0])) = w
	*(*int32)(unsafe.Pointer(&vt.Value[4])) = h
	return vt
}

// =============================================================================
// Vtable indices for each AMF interface
//
// AMF interfaces inherit from AMFInterface (Acquire/Release/QI at 0-2).
// AMFPropertyStorage adds SetProperty/GetProperty at 3-12.
// Domain interfaces extend from there.
// AMFFactory does NOT inherit from AMFInterface (no ref counting).
// =============================================================================

// AMFFactory — flat vtable, no base class
const (
	amfFactoryCreateContext   = 0
	amfFactoryCreateComponent = 1
)

// AMFInterface (base of all ref-counted objects)
const (
	amfAcquire       = 0
	amfRelease       = 1
	amfQueryInterface = 2
)

// AMFPropertyStorage (extends AMFInterface)
const (
	amfPropSetProperty = 3
	amfPropGetProperty = 4
)

// AMFContext (extends AMFPropertyStorage, indices 0-12)
const (
	amfCtxTerminate          = 13
	amfCtxInitDX11           = 18
	amfCtxGetDX11Device      = 19
	amfCtxAllocSurface       = 44
	amfCtxCreateSurfFromDX11 = 49
)

// AMFComponent / encoder (extends AMFPropertyStorageEx, indices 0-16)
const (
	amfCompInit        = 17
	amfCompReInit      = 18
	amfCompTerminate   = 19
	amfCompDrain       = 20
	amfCompFlush       = 21
	amfCompSubmitInput = 22
	amfCompQueryOutput = 23
)

// AMFData (extends AMFPropertyStorage, indices 0-12)
const (
	amfDataSetPts = 19
	amfDataGetPts = 20
)

// AMFBuffer (extends AMFData, indices 0-22)
const (
	amfBufGetSize   = 24
	amfBufGetNative = 25
)

// =============================================================================
// VideoEncoderVCE.h — H.264 encoder constants
// =============================================================================

// Encoder component ID (wide string for CreateComponent)
const amfEncoderAVC = "AMFVideoEncoderVCE_AVC"

// Usage enum
const (
	amfUsageTranscoding      = 0
	amfUsageUltraLowLatency  = 1
	amfUsageLowLatency       = 2
	amfUsageWebcam           = 3
	amfUsageHighQuality      = 4
	amfUsageLowLatencyHQ     = 5
)

// Rate control method
const (
	amfRCConstQP           = 0
	amfRCCBR               = 1
	amfRCPeakVBR           = 2
	amfRCLatencyVBR        = 3
	amfRCQualityVBR        = 4
	amfRCHighQualityVBR    = 5
	amfRCHighQualityCBR    = 6
)

// Quality presets
const (
	amfQualityBalanced = 0
	amfQualitySpeed    = 1
	amfQualityQuality  = 2
)

// Picture type (for force IDR)
const (
	amfPicTypeNone = 0
	amfPicTypeSkip = 1
	amfPicTypeIDR  = 2
	amfPicTypeI    = 3
	amfPicTypeP    = 4
	amfPicTypeB    = 5
)

// Profile
const (
	amfProfileBaseline          = 66
	amfProfileMain              = 77
	amfProfileHigh              = 100
	amfProfileConstrainedBase   = 256
	amfProfileConstrainedHigh   = 257
)

// Property name strings (passed as wide strings to SetProperty)
const (
	amfPropUsage           = "Usage"
	amfPropProfile         = "Profile"
	amfPropProfileLevel    = "ProfileLevel"
	amfPropQualityPreset   = "QualityPreset"
	amfPropRateControl     = "RateControlMethod"
	amfPropLowLatency      = "LowLatencyInternal"
	amfPropTargetBitrate   = "TargetBitrate"
	amfPropPeakBitrate     = "PeakBitrate"
	amfPropFrameRate       = "FrameRate"
	amfPropIDRPeriod       = "IDRPeriod"
	amfPropBPicPattern     = "BPicturesPattern"
	amfPropSlicesPerFrame  = "SlicesPerFrame"
	amfPropMinQP           = "MinQP"
	amfPropMaxQP           = "MaxQP"
	amfPropVBAQ            = "EnableVBAQ"
	amfPropFillerData      = "FillerDataEnable"
	amfPropEnforceHRD      = "EnforceHRD"
	amfPropDeblocking      = "DeBlockingFilter"
	amfPropForcePicType    = "ForcePictureType"
	amfPropInsertSPS       = "InsertSPS"
	amfPropInsertPPS       = "InsertPPS"
)

// =============================================================================
// Vtable call helpers
// =============================================================================

// amfCall invokes a COM-style vtable method on an AMF object.
// obj is the interface pointer; vtableIdx is the 0-based method index.
func amfCall(obj uintptr, vtableIdx int, args ...uintptr) uintptr {
	vtable := *(*uintptr)(unsafe.Pointer(obj))
	fn := *(*uintptr)(unsafe.Pointer(vtable + uintptr(vtableIdx)*unsafe.Sizeof(uintptr(0))))
	allArgs := make([]uintptr, 1+len(args))
	allArgs[0] = obj
	copy(allArgs[1:], args)
	r, _, _ := syscall.SyscallN(fn, allArgs...)
	return r
}

// amfRelease decrements the reference count on an AMF object.
func amfReleaseObj(obj uintptr) {
	if obj != 0 {
		amfCall(obj, amfRelease)
	}
}

// amfSetPropInt64 sets an int64 property on an AMF object (encoder, surface, etc.).
func amfSetPropInt64(obj uintptr, name string, val int64) error {
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	vt := amfVariantInt64(val)
	r := amfCall(obj, amfPropSetProperty,
		uintptr(unsafe.Pointer(namePtr)),
		uintptr(unsafe.Pointer(&vt)),
	)
	runtime.KeepAlive(namePtr)
	runtime.KeepAlive(vt)
	if r != amfOK {
		return fmt.Errorf("AMF SetProperty(%s) failed: %s", name, amfResultStr(r))
	}
	return nil
}

// amfSetPropBool sets a bool property on an AMF object.
func amfSetPropBool(obj uintptr, name string, val bool) error {
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	vt := amfVariantBool(val)
	r := amfCall(obj, amfPropSetProperty,
		uintptr(unsafe.Pointer(namePtr)),
		uintptr(unsafe.Pointer(&vt)),
	)
	runtime.KeepAlive(namePtr)
	runtime.KeepAlive(vt)
	if r != amfOK {
		return fmt.Errorf("AMF SetProperty(%s) failed: %s", name, amfResultStr(r))
	}
	return nil
}

// amfSetPropRate sets an AMFRate property on an AMF object.
func amfSetPropRate(obj uintptr, name string, num, den uint32) error {
	namePtr, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	vt := amfVariantRate(num, den)
	r := amfCall(obj, amfPropSetProperty,
		uintptr(unsafe.Pointer(namePtr)),
		uintptr(unsafe.Pointer(&vt)),
	)
	runtime.KeepAlive(namePtr)
	runtime.KeepAlive(vt)
	if r != amfOK {
		return fmt.Errorf("AMF SetProperty(%s) failed: %s", name, amfResultStr(r))
	}
	return nil
}

func init() {
	// Verify amfVariant size matches AMFVariantStruct (24 bytes on 64-bit)
	if s := unsafe.Sizeof(amfVariant{}); s != 24 {
		panic(fmt.Sprintf("amfVariant size %d, expected 24", s))
	}
}
