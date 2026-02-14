//go:build darwin && cgo
// +build darwin,cgo

package desktop

/*
#cgo LDFLAGS: -framework VideoToolbox -framework CoreMedia -framework CoreVideo -framework CoreFoundation

#include <CoreFoundation/CoreFoundation.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <VideoToolbox/VideoToolbox.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

extern void goVTCompressionOutputCallback(uintptr_t outputCallbackRefCon, uintptr_t sourceFrameRefCon, int32_t status, uint32_t infoFlags, CMSampleBufferRef sampleBuffer);

static void vtOutputCallback(void *outputCallbackRefCon,
                             void *sourceFrameRefCon,
                             OSStatus status,
                             VTEncodeInfoFlags infoFlags,
                             CMSampleBufferRef sampleBuffer) {
    goVTCompressionOutputCallback((uintptr_t)outputCallbackRefCon,
                                  (uintptr_t)sourceFrameRefCon,
                                  (int32_t)status,
                                  (uint32_t)infoFlags,
                                  sampleBuffer);
}

static OSStatus vtCreateH264Session(int width, int height, VTCompressionSessionRef *sessionOut) {
    if (sessionOut == NULL) return -1;

    // Prefer hardware if available, but don't require it.
    CFTypeRef hwTrue = kCFBooleanTrue;
    const void *specKeys[] = {
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
    };
    const void *specVals[] = {
        hwTrue,
    };
    CFDictionaryRef encoderSpec = CFDictionaryCreate(kCFAllocatorDefault,
                                                     specKeys, specVals, 1,
                                                     &kCFTypeDictionaryKeyCallBacks,
                                                     &kCFTypeDictionaryValueCallBacks);

    // Request NV12 input buffers (video range) backed by IOSurface (helps HW encoders).
    int32_t w = width;
    int32_t h = height;
    uint32_t pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
    CFNumberRef widthNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &w);
    CFNumberRef heightNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &h);
    CFNumberRef pfNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pixelFormat);
    CFDictionaryRef ioSurfProps = CFDictionaryCreate(kCFAllocatorDefault, NULL, NULL, 0,
                                                     &kCFTypeDictionaryKeyCallBacks,
                                                     &kCFTypeDictionaryValueCallBacks);

    const void *attrKeys[] = {
        kCVPixelBufferPixelFormatTypeKey,
        kCVPixelBufferWidthKey,
        kCVPixelBufferHeightKey,
        kCVPixelBufferIOSurfacePropertiesKey,
    };
    const void *attrVals[] = {
        pfNum,
        widthNum,
        heightNum,
        ioSurfProps,
    };

    CFDictionaryRef attrs = CFDictionaryCreate(kCFAllocatorDefault,
                                               attrKeys, attrVals, 4,
                                               &kCFTypeDictionaryKeyCallBacks,
                                               &kCFTypeDictionaryValueCallBacks);

    CFRelease(widthNum);
    CFRelease(heightNum);
    CFRelease(pfNum);
    CFRelease(ioSurfProps);

    OSStatus status = VTCompressionSessionCreate(kCFAllocatorDefault,
                                                 width,
                                                 height,
                                                 kCMVideoCodecType_H264,
                                                 encoderSpec,
                                                 attrs,
                                                 NULL,
                                                 vtOutputCallback,
                                                 NULL,
                                                 sessionOut);

    if (attrs) CFRelease(attrs);
    if (encoderSpec) CFRelease(encoderSpec);
    return status;
}

static OSStatus vtSetPropertyBool(VTCompressionSessionRef session, CFStringRef key, int value) {
    if (session == NULL || key == NULL) return -1;
    return VTSessionSetProperty(session, key, value ? kCFBooleanTrue : kCFBooleanFalse);
}

static OSStatus vtSetPropertyInt(VTCompressionSessionRef session, CFStringRef key, int32_t value) {
    if (session == NULL || key == NULL) return -1;
    CFNumberRef num = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &value);
    if (!num) return -1;
    OSStatus st = VTSessionSetProperty(session, key, num);
    CFRelease(num);
    return st;
}

static OSStatus vtSetPropertyFloat(VTCompressionSessionRef session, CFStringRef key, float value) {
    if (session == NULL || key == NULL) return -1;
    CFNumberRef num = CFNumberCreate(kCFAllocatorDefault, kCFNumberFloat32Type, &value);
    if (!num) return -1;
    OSStatus st = VTSessionSetProperty(session, key, num);
    CFRelease(num);
    return st;
}

static OSStatus vtSetPropertyString(VTCompressionSessionRef session, CFStringRef key, CFStringRef value) {
    if (session == NULL || key == NULL || value == NULL) return -1;
    return VTSessionSetProperty(session, key, value);
}

static OSStatus vtSetDataRateLimits(VTCompressionSessionRef session, int32_t bytesPerSecond, int32_t seconds) {
    if (session == NULL) return -1;
    CFNumberRef bps = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &bytesPerSecond);
    CFNumberRef sec = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &seconds);
    if (!bps || !sec) {
        if (bps) CFRelease(bps);
        if (sec) CFRelease(sec);
        return -1;
    }
    const void *vals[] = { bps, sec };
    CFArrayRef arr = CFArrayCreate(kCFAllocatorDefault, vals, 2, &kCFTypeArrayCallBacks);
    CFRelease(bps);
    CFRelease(sec);
    if (!arr) return -1;
    OSStatus st = VTSessionSetProperty(session, kVTCompressionPropertyKey_DataRateLimits, arr);
    CFRelease(arr);
    return st;
}

static OSStatus vtPrepare(VTCompressionSessionRef session) {
    if (session == NULL) return -1;
    return VTCompressionSessionPrepareToEncodeFrames(session);
}

static CVPixelBufferPoolRef vtGetPixelBufferPool(VTCompressionSessionRef session) {
    if (session == NULL) return NULL;
    return VTCompressionSessionGetPixelBufferPool(session);
}

static OSStatus vtEncodeNV12(VTCompressionSessionRef session,
                             CVPixelBufferPoolRef pool,
                             uint8_t *nv12,
                             int width,
                             int height,
                             int64_t ptsNs,
                             int64_t durNs,
                             uintptr_t sourceFrameRefCon) {
    if (session == NULL || nv12 == NULL || width <= 0 || height <= 0) return -1;
    if (pool == NULL) {
        pool = VTCompressionSessionGetPixelBufferPool(session);
        if (pool == NULL) return -1;
    }

    CVPixelBufferRef pb = NULL;
    OSStatus st = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &pb);
    if (st != noErr || pb == NULL) return st;

    CVPixelBufferLockBaseAddress(pb, 0);

    // Copy Y plane.
    size_t dstYStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 0);
    uint8_t *dstY = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pb, 0);
    uint8_t *srcY = nv12;
    for (int y = 0; y < height; y++) {
        memcpy(dstY + (size_t)y * dstYStride, srcY + (size_t)y * (size_t)width, (size_t)width);
    }

    // Copy UV plane.
    size_t dstUVStride = CVPixelBufferGetBytesPerRowOfPlane(pb, 1);
    uint8_t *dstUV = (uint8_t *)CVPixelBufferGetBaseAddressOfPlane(pb, 1);
    uint8_t *srcUV = nv12 + (size_t)width * (size_t)height;
    int uvRows = height / 2;
    for (int y = 0; y < uvRows; y++) {
        memcpy(dstUV + (size_t)y * dstUVStride, srcUV + (size_t)y * (size_t)width, (size_t)width);
    }

    CVPixelBufferUnlockBaseAddress(pb, 0);

    CMTime pts = CMTimeMake(ptsNs, 1000000000);
    CMTime dur = CMTimeMake(durNs, 1000000000);

    st = VTCompressionSessionEncodeFrame(session,
                                         pb,
                                         pts,
                                         dur,
                                         NULL,
                                         (void *)sourceFrameRefCon,
                                         NULL);

    CVPixelBufferRelease(pb);
    return st;
}

static void vtDestroySession(VTCompressionSessionRef session) {
    if (session == NULL) return;
    VTCompressionSessionCompleteFrames(session, kCMTimeInvalid);
    VTCompressionSessionInvalidate(session);
    CFRelease(session);
}

static int vtSampleIsKeyframe(CMSampleBufferRef sample) {
    if (sample == NULL) return 0;
    CFArrayRef attachments = CMSampleBufferGetSampleAttachmentsArray(sample, false);
    if (attachments == NULL || CFArrayGetCount(attachments) == 0) {
        return 1;
    }
    CFDictionaryRef dict = (CFDictionaryRef)CFArrayGetValueAtIndex(attachments, 0);
    if (dict == NULL) return 1;
    CFBooleanRef notSync = (CFBooleanRef)CFDictionaryGetValue(dict, kCMSampleAttachmentKey_NotSync);
    if (notSync == NULL) return 1;
    return (notSync == kCFBooleanFalse) ? 1 : 0;
}

static OSStatus vtCopyAnnexBFromSample(CMSampleBufferRef sample, uint8_t **outBytes, size_t *outLen) {
    if (outBytes == NULL || outLen == NULL) return -1;
    *outBytes = NULL;
    *outLen = 0;
    if (sample == NULL) return -1;

    CMBlockBufferRef bb = CMSampleBufferGetDataBuffer(sample);
    if (bb == NULL) return -1;

    size_t length = CMBlockBufferGetDataLength(bb);
    if (length == 0) return -1;

    uint8_t *buf = (uint8_t *)malloc(length);
    if (buf == NULL) return -1;

    OSStatus st = CMBlockBufferCopyDataBytes(bb, 0, length, buf);
    if (st != noErr) {
        free(buf);
        return st;
    }

    // Convert AVCC (length-prefixed) to Annex-B (start-code prefixed) in place.
    size_t i = 0;
    while (i + 4 <= length) {
        uint32_t nalLen = ((uint32_t)buf[i] << 24) |
                          ((uint32_t)buf[i+1] << 16) |
                          ((uint32_t)buf[i+2] << 8) |
                          ((uint32_t)buf[i+3]);
        buf[i] = 0;
        buf[i+1] = 0;
        buf[i+2] = 0;
        buf[i+3] = 1;
        i += 4;
        if (nalLen == 0 || i + (size_t)nalLen > length) {
            free(buf);
            return -1;
        }
        i += (size_t)nalLen;
    }

    *outBytes = buf;
    *outLen = length;
    return noErr;
}

static OSStatus vtCopySPSPPSFromSample(CMSampleBufferRef sample,
                                      uint8_t **spsOut, size_t *spsLen,
                                      uint8_t **ppsOut, size_t *ppsLen) {
    if (spsOut == NULL || spsLen == NULL || ppsOut == NULL || ppsLen == NULL) return -1;
    *spsOut = NULL;
    *ppsOut = NULL;
    *spsLen = 0;
    *ppsLen = 0;
    if (sample == NULL) return -1;

    CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sample);
    if (fmt == NULL) return -1;

    const uint8_t *spsPtr = NULL;
    const uint8_t *ppsPtr = NULL;
    size_t spsSize = 0;
    size_t ppsSize = 0;
    size_t psCount = 0;
    int nalHeaderLen = 0;

    OSStatus st = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 0, &spsPtr, &spsSize, &psCount, &nalHeaderLen);
    if (st != noErr || spsPtr == NULL || spsSize == 0) return st != noErr ? st : -1;
    st = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, 1, &ppsPtr, &ppsSize, &psCount, &nalHeaderLen);
    if (st != noErr || ppsPtr == NULL || ppsSize == 0) return st != noErr ? st : -1;

    uint8_t *sps = (uint8_t *)malloc(spsSize);
    uint8_t *pps = (uint8_t *)malloc(ppsSize);
    if (sps == NULL || pps == NULL) {
        if (sps) free(sps);
        if (pps) free(pps);
        return -1;
    }
    memcpy(sps, spsPtr, spsSize);
    memcpy(pps, ppsPtr, ppsSize);

    *spsOut = sps;
    *ppsOut = pps;
    *spsLen = spsSize;
    *ppsLen = ppsSize;
    return noErr;
}

static void vtFree(void *p) {
    if (p != NULL) free(p);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"runtime/cgo"
	"sync"
	"time"
	"unsafe"
)

type videotoolboxEncoder struct {
	mu     sync.Mutex
	cfg    EncoderConfig
	width  int
	height int
	stride int

	session C.VTCompressionSessionRef
	pool    C.CVPixelBufferPoolRef

	startTime time.Time
}

func init() {
	registerHardwareFactory(newVideoToolboxEncoder)
}

func newVideoToolboxEncoder(cfg EncoderConfig) (encoderBackend, error) {
	if cfg.Codec != CodecH264 {
		return nil, fmt.Errorf("videotoolbox unsupported codec: %s", cfg.Codec)
	}
	return &videotoolboxEncoder{cfg: cfg}, nil
}

func (v *videotoolboxEncoder) Encode(frame []byte) ([]byte, error) {
	if len(frame) == 0 {
		return nil, errors.New("empty frame")
	}

	v.mu.Lock()
	session := v.session
	pool := v.pool
	width := v.width
	height := v.height
	stride := v.stride
	fps := v.cfg.FPS
	start := v.startTime
	v.mu.Unlock()

	if session == 0 || width <= 0 || height <= 0 || stride <= 0 {
		return nil, fmt.Errorf("videotoolbox encoder: call SetDimensions before Encode")
	}

	pixelCount := len(frame) / 4
	if pixelCount != width*height {
		return nil, fmt.Errorf("videotoolbox: frame size mismatch: got %d pixels, want %dx%d", pixelCount, width, height)
	}

	// Convert RGBA → NV12 (video-range).
	nv12 := rgbaToNV12(frame, width, height, stride)
	defer putNV12Buffer(nv12)

	req := &vtEncodeRequest{ch: make(chan vtEncodeResult, 1)}
	h := cgo.NewHandle(req)

	// Use monotonic timestamps for rate control (PTS/DTS don't flow to WebRTC).
	ptsNs := time.Since(start).Nanoseconds()
	durNs := int64(time.Second / time.Duration(clampInt(fps, 1, maxFrameRate)))

	var nv12Ptr *C.uint8_t
	if len(nv12) > 0 {
		nv12Ptr = (*C.uint8_t)(unsafe.Pointer(&nv12[0]))
	}

	st := C.vtEncodeNV12(session, pool, nv12Ptr, C.int(width), C.int(height), C.int64_t(ptsNs), C.int64_t(durNs), C.uintptr_t(h))
	if st != 0 {
		// If encode failed, we own the handle and must delete it.
		h.Delete()
		return nil, fmt.Errorf("videotoolbox encode failed: OSStatus=%d", int32(st))
	}

	select {
	case res := <-req.ch:
		return res.data, res.err
	case <-time.After(2 * time.Second):
		// Don't delete the handle here; the callback may still arrive and clean it up.
		return nil, fmt.Errorf("videotoolbox encode timed out")
	}
}

func (v *videotoolboxEncoder) SetCodec(codec Codec) error {
	if !codec.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidCodec, codec)
	}
	if codec != CodecH264 {
		return fmt.Errorf("videotoolbox unsupported codec: %s", codec)
	}
	v.mu.Lock()
	v.cfg.Codec = codec
	v.mu.Unlock()
	return nil
}

func (v *videotoolboxEncoder) SetQuality(quality QualityPreset) error {
	if !quality.valid() {
		return fmt.Errorf("%w: %s", ErrInvalidQuality, quality)
	}
	v.mu.Lock()
	v.cfg.Quality = quality
	session := v.session
	v.mu.Unlock()

	if session == 0 {
		return nil
	}

	// Best-effort hint; VT can ignore this in constrained bitrate mode.
	if q, ok := vtQualityFloat(quality); ok {
		if st := C.vtSetPropertyFloat(session, C.kVTCompressionPropertyKey_Quality, C.float(q)); st != 0 {
			return fmt.Errorf("videotoolbox set quality: OSStatus=%d", int32(st))
		}
	}
	return nil
}

func (v *videotoolboxEncoder) SetBitrate(bitrate int) error {
	if bitrate <= 0 {
		return ErrInvalidBitrate
	}
	v.mu.Lock()
	v.cfg.Bitrate = bitrate
	session := v.session
	v.mu.Unlock()

	if session == 0 {
		return nil
	}
	if st := C.vtSetPropertyInt(session, C.kVTCompressionPropertyKey_AverageBitRate, C.int32_t(bitrate)); st != 0 {
		return fmt.Errorf("videotoolbox set bitrate: OSStatus=%d", int32(st))
	}
	// DataRateLimits uses bytes/sec.
	_ = C.vtSetDataRateLimits(session, C.int32_t(bitrate/8), 1)
	return nil
}

func (v *videotoolboxEncoder) SetFPS(fps int) error {
	if fps <= 0 {
		return ErrInvalidFPS
	}
	v.mu.Lock()
	v.cfg.FPS = fps
	session := v.session
	v.mu.Unlock()

	if session == 0 {
		return nil
	}
	if st := C.vtSetPropertyInt(session, C.kVTCompressionPropertyKey_ExpectedFrameRate, C.int32_t(fps)); st != 0 {
		return fmt.Errorf("videotoolbox set fps: OSStatus=%d", int32(st))
	}
	// Keep keyframes reasonably frequent (2s).
	_ = C.vtSetPropertyInt(session, C.kVTCompressionPropertyKey_MaxKeyFrameInterval, C.int32_t(fps*2))
	return nil
}

func (v *videotoolboxEncoder) SetPixelFormat(pf PixelFormat) {}

func (v *videotoolboxEncoder) SetDimensions(width, height int) error {
	// NV12 requires even dimensions.
	width = width &^ 1
	height = height &^ 1

	if width <= 0 || height <= 0 {
		return fmt.Errorf("invalid dimensions: %dx%d", width, height)
	}

	v.mu.Lock()
	defer v.mu.Unlock()

	if v.session != 0 && (v.width != width || v.height != height) {
		v.closeLocked()
	}

	v.width = width
	v.height = height
	v.stride = width * 4

	if v.session != 0 {
		return nil
	}

	var session C.VTCompressionSessionRef
	if st := C.vtCreateH264Session(C.int(width), C.int(height), &session); st != 0 || session == 0 {
		return fmt.Errorf("videotoolbox create session failed: OSStatus=%d", int32(st))
	}

	// Apply baseline realtime config.
	_ = C.vtSetPropertyBool(session, C.kVTCompressionPropertyKey_RealTime, 1)
	_ = C.vtSetPropertyBool(session, C.kVTCompressionPropertyKey_AllowFrameReordering, 0)
	_ = C.vtSetPropertyString(session, C.kVTCompressionPropertyKey_ProfileLevel, C.kVTProfileLevel_H264_Baseline_AutoLevel)
	_ = C.vtSetPropertyString(session, C.kVTCompressionPropertyKey_H264EntropyMode, C.kVTH264EntropyMode_CAVLC)

	// Bitrate + FPS.
	_ = C.vtSetPropertyInt(session, C.kVTCompressionPropertyKey_AverageBitRate, C.int32_t(v.cfg.Bitrate))
	_ = C.vtSetDataRateLimits(session, C.int32_t(v.cfg.Bitrate/8), 1)
	_ = C.vtSetPropertyInt(session, C.kVTCompressionPropertyKey_ExpectedFrameRate, C.int32_t(v.cfg.FPS))
	_ = C.vtSetPropertyInt(session, C.kVTCompressionPropertyKey_MaxKeyFrameInterval, C.int32_t(v.cfg.FPS*2))

	if q, ok := vtQualityFloat(v.cfg.Quality); ok {
		_ = C.vtSetPropertyFloat(session, C.kVTCompressionPropertyKey_Quality, C.float(q))
	}

	if st := C.vtPrepare(session); st != 0 {
		C.vtDestroySession(session)
		return fmt.Errorf("videotoolbox prepare failed: OSStatus=%d", int32(st))
	}

	pool := C.vtGetPixelBufferPool(session)
	if pool != 0 {
		// Retain so the Go struct can safely hold it.
		C.CFRetain(C.CFTypeRef(pool))
	}

	v.session = session
	v.pool = pool
	v.startTime = time.Now()

	return nil
}

func (v *videotoolboxEncoder) Close() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.closeLocked()
	return nil
}

func (v *videotoolboxEncoder) Name() string {
	return "videotoolbox"
}

func (v *videotoolboxEncoder) IsHardware() bool {
	return true
}

func (v *videotoolboxEncoder) IsPlaceholder() bool {
	return false
}

func (v *videotoolboxEncoder) SetD3D11Device(device, context uintptr)            {}
func (v *videotoolboxEncoder) SupportsGPUInput() bool                            { return false }
func (v *videotoolboxEncoder) EncodeTexture(bgraTexture uintptr) ([]byte, error) {
	return nil, errors.New("GPU input not supported by videotoolbox encoder")
}

func (v *videotoolboxEncoder) closeLocked() {
	if v.pool != 0 {
		C.CFRelease(C.CFTypeRef(v.pool))
		v.pool = 0
	}
	if v.session != 0 {
		C.vtDestroySession(v.session)
		v.session = 0
	}
}

type vtEncodeRequest struct {
	ch chan vtEncodeResult
}

type vtEncodeResult struct {
	data []byte
	err  error
}

func vtQualityFloat(q QualityPreset) (float32, bool) {
	switch q {
	case QualityLow:
		return 0.25, true
	case QualityMedium:
		return 0.5, true
	case QualityHigh:
		return 0.75, true
	case QualityUltra:
		return 1.0, true
	case QualityAuto:
		return 0, false
	default:
		return 0, false
	}
}

var h264StartCode = []byte{0, 0, 0, 1}

//export goVTCompressionOutputCallback
func goVTCompressionOutputCallback(outputCallbackRefCon C.uintptr_t, sourceFrameRefCon C.uintptr_t, status C.int32_t, infoFlags C.uint32_t, sampleBuffer C.CMSampleBufferRef) {
	defer func() {
		// Defensive: a stale/invalid sourceFrameRefCon would otherwise panic
		// on cgo.Handle.Value() and crash the process.
		_ = recover()
	}()

	_ = outputCallbackRefCon
	_ = infoFlags

	if sourceFrameRefCon == 0 {
		return
	}
	h := cgo.Handle(uintptr(sourceFrameRefCon))
	reqAny := h.Value()
	h.Delete()

	req, ok := reqAny.(*vtEncodeRequest)
	if !ok || req == nil || req.ch == nil {
		return
	}

	if status != 0 {
		req.ch <- vtEncodeResult{err: fmt.Errorf("videotoolbox output callback: OSStatus=%d", int32(status))}
		return
	}
	if sampleBuffer == 0 {
		req.ch <- vtEncodeResult{err: errors.New("videotoolbox output callback: nil sample buffer")}
		return
	}

	keyframe := C.vtSampleIsKeyframe(sampleBuffer) != 0

	var annexPtr *C.uint8_t
	var annexLen C.size_t
	if st := C.vtCopyAnnexBFromSample(sampleBuffer, &annexPtr, &annexLen); st != 0 || annexPtr == nil || annexLen == 0 {
		if annexPtr != nil {
			C.vtFree(unsafe.Pointer(annexPtr))
		}
		req.ch <- vtEncodeResult{err: fmt.Errorf("videotoolbox copy sample: OSStatus=%d", int32(st))}
		return
	}
	defer C.vtFree(unsafe.Pointer(annexPtr))
	annex := C.GoBytes(unsafe.Pointer(annexPtr), C.int(annexLen))

	if !keyframe {
		req.ch <- vtEncodeResult{data: annex}
		return
	}

	var spsPtr *C.uint8_t
	var ppsPtr *C.uint8_t
	var spsLen C.size_t
	var ppsLen C.size_t
	st := C.vtCopySPSPPSFromSample(sampleBuffer, &spsPtr, &spsLen, &ppsPtr, &ppsLen)
	if st != 0 || spsPtr == nil || ppsPtr == nil || spsLen == 0 || ppsLen == 0 {
		if spsPtr != nil {
			C.vtFree(unsafe.Pointer(spsPtr))
		}
		if ppsPtr != nil {
			C.vtFree(unsafe.Pointer(ppsPtr))
		}
		// Even if we can't read SPS/PPS, return the frame data.
		req.ch <- vtEncodeResult{data: annex}
		return
	}
	defer C.vtFree(unsafe.Pointer(spsPtr))
	defer C.vtFree(unsafe.Pointer(ppsPtr))

	sps := C.GoBytes(unsafe.Pointer(spsPtr), C.int(spsLen))
	pps := C.GoBytes(unsafe.Pointer(ppsPtr), C.int(ppsLen))

	// Prefix SPS/PPS for keyframes so decoders can start mid-stream.
	out := make([]byte, 0, len(sps)+len(pps)+len(annex)+12)
	out = append(out, h264StartCode...)
	out = append(out, sps...)
	out = append(out, h264StartCode...)
	out = append(out, pps...)
	out = append(out, annex...)

	req.ch <- vtEncodeResult{data: out}
}
