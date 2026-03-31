//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework IOSurface

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <dispatch/dispatch.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
} ScreenCaptureResult;

CGDisplayStreamRef CGDisplayStreamCreateWithDispatchQueue_compat(
    CGDirectDisplayID display,
    size_t outputWidth,
    size_t outputHeight,
    int32_t pixelFormat,
    CFDictionaryRef properties,
    dispatch_queue_t queue,
    CGDisplayStreamFrameAvailableHandler handler
) __asm__("_CGDisplayStreamCreateWithDispatchQueue");

CGError CGDisplayStreamStart_compat(CGDisplayStreamRef displayStream)
    __asm__("_CGDisplayStreamStart");

CGError CGDisplayStreamStop_compat(CGDisplayStreamRef displayStream)
    __asm__("_CGDisplayStreamStop");

static CGDirectDisplayID g_streamDisplayID = 0;
static CGDisplayStreamRef g_displayStream = NULL;
static dispatch_queue_t g_displayQueue = NULL;
static IOSurfaceRef g_latestSurface = NULL;

static void releaseDisplayStreamCapture(void) {
    if (g_displayStream != NULL) {
        CGDisplayStreamStop_compat(g_displayStream);
        CFRelease(g_displayStream);
        g_displayStream = NULL;
    }
    if (g_latestSurface != NULL) {
        CFRelease(g_latestSurface);
        g_latestSurface = NULL;
    }
    g_displayQueue = NULL;
    g_streamDisplayID = 0;
}

static int initCaptureStream(int displayIndex) {
    releaseDisplayStreamCapture();

    uint32_t maxDisplays = 16;
    CGDirectDisplayID displays[16];
    uint32_t displayCount = 0;
    CGError err = CGGetActiveDisplayList(maxDisplays, displays, &displayCount);
    if (err != kCGErrorSuccess || displayCount == 0) {
        return 1;
    }

    uint32_t idx = (uint32_t)displayIndex;
    if (idx >= displayCount) idx = 0;
    g_streamDisplayID = displays[idx];

    size_t width = CGDisplayPixelsWide(g_streamDisplayID);
    size_t height = CGDisplayPixelsHigh(g_streamDisplayID);
    if (width == 0 || height == 0) {
        return 2;
    }

    g_displayQueue = dispatch_queue_create("com.breeze.desktop.loginwindow", DISPATCH_QUEUE_SERIAL);
    if (g_displayQueue == NULL) {
        return 5;
    }

    g_displayStream = CGDisplayStreamCreateWithDispatchQueue_compat(
        g_streamDisplayID,
        width,
        height,
        'BGRA',
        NULL,
        g_displayQueue,
        ^(CGDisplayStreamFrameStatus status, uint64_t displayTime, IOSurfaceRef frameSurface, CGDisplayStreamUpdateRef updateRef) {
            if (status != kCGDisplayStreamFrameStatusFrameComplete || frameSurface == NULL) {
                return;
            }
            if (g_latestSurface != NULL) {
                CFRelease(g_latestSurface);
            }
            g_latestSurface = (IOSurfaceRef)CFRetain(frameSurface);
        }
    );
    if (g_displayStream == NULL) {
        return 9;
    }
    if (CGDisplayStreamStart_compat(g_displayStream) != kCGErrorSuccess) {
        releaseDisplayStreamCapture();
        return 10;
    }
    return 0;
}

static ScreenCaptureResult captureFrameStream(void) {
    ScreenCaptureResult result = {0};

    if (g_displayStream == NULL) {
        result.error = 6;
        return result;
    }

    IOSurfaceRef surface = NULL;
    for (int i = 0; i < 50; i++) {
        if (g_latestSurface != NULL) {
            surface = (IOSurfaceRef)CFRetain(g_latestSurface);
            break;
        }
        usleep(10000);
    }
    if (surface == NULL) {
        result.error = 3;
        return result;
    }

    IOSurfaceLock(surface, kIOSurfaceLockReadOnly, NULL);
    result.width = (int)IOSurfaceGetWidth(surface);
    result.height = (int)IOSurfaceGetHeight(surface);
    result.bytesPerRow = (int)IOSurfaceGetBytesPerRow(surface);

    size_t dataSize = (size_t)result.bytesPerRow * (size_t)result.height;
    result.data = malloc(dataSize);
    if (result.data == NULL) {
        IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
        CFRelease(surface);
        result.error = 4;
        return result;
    }

    void* base = IOSurfaceGetBaseAddress(surface);
    if (base == NULL) {
        free(result.data);
        result.data = NULL;
        IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
        CFRelease(surface);
        result.error = 3;
        return result;
    }

    memcpy(result.data, base, dataSize);
    IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, NULL);
    CFRelease(surface);
    return result;
}

static void freeCaptureStream(void* data) {
    if (data != NULL) {
        free(data);
    }
}
*/
import "C"

import (
	"fmt"
	"image"
)

type darwinDisplayStreamCapturer struct {
	config          CaptureConfig
	initialized     bool
	holdsGlobalLock bool
}

func newDisplayStreamCapturer(config CaptureConfig) (ScreenCapturer, error) {
	darwinCaptureMu.Lock()
	errCode := int(C.initCaptureStream(C.int(config.DisplayIndex)))
	if errCode != 0 {
		darwinCaptureMu.Unlock()
		return nil, translateDarwinError(errCode)
	}
	return &darwinDisplayStreamCapturer{config: config, initialized: true, holdsGlobalLock: true}, nil
}

func (c *darwinDisplayStreamCapturer) Capture() (*image.RGBA, error) {
	result := C.captureFrameStream()
	if result.error != 0 {
		return nil, translateDarwinError(int(result.error))
	}
	if result.data == nil {
		return nil, fmt.Errorf("no frame captured")
	}
	defer C.freeCaptureStream(result.data)
	return createImageFromDisplayStreamResult(result)
}

func (c *darwinDisplayStreamCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	return captureRegionFromFull(c, x, y, width, height)
}

func (c *darwinDisplayStreamCapturer) GetScreenBounds() (width, height int, err error) {
	return getScreenBoundsC(c.config.DisplayIndex)
}

func (c *darwinDisplayStreamCapturer) Close() error {
	if c.initialized {
		C.releaseDisplayStreamCapture()
		c.initialized = false
	}
	if c.holdsGlobalLock {
		c.holdsGlobalLock = false
		darwinCaptureMu.Unlock()
	}
	return nil
}

func createImageFromDisplayStreamResult(result C.ScreenCaptureResult) (*image.RGBA, error) {
	width := int(result.width)
	height := int(result.height)
	bytesPerRow := int(result.bytesPerRow)

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	dataSize := bytesPerRow * height
	cData := C.GoBytes(result.data, C.int(dataSize))

	for y := 0; y < height; y++ {
		srcStart := y * bytesPerRow
		dstStart := y * img.Stride
		copy(img.Pix[dstStart:dstStart+width*4], cData[srcStart:srcStart+width*4])
	}

	return img, nil
}

var _ ScreenCapturer = (*darwinDisplayStreamCapturer)(nil)
