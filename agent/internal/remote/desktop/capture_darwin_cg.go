//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework AppKit

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>

// CGWindowListCreateImage is marked unavailable in macOS 15 SDK headers.
// We still need it as a fallback for macOS 12-13 where ScreenCaptureKit
// SCScreenshotManager is not available. Re-declare without the availability
// attribute so we can compile against it.
CGImageRef CGWindowListCreateImage_compat(CGRect screenBounds,
    CGWindowListOption listOption, CGWindowID windowID,
    CGWindowImageOption imageOption) __asm__("_CGWindowListCreateImage");

// ScreenCaptureResult holds the capture result (must match capture_darwin.go)
typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
} ScreenCaptureResult;

// ---- CoreGraphics fallback path (macOS 12-13) ----

// Cached display ID for CGWindowListCreateImage fallback
static CGDirectDisplayID g_cgDisplayID = 0;
static int g_cgDisplayWidth = 0;
static int g_cgDisplayHeight = 0;

// initCaptureCG initializes the CoreGraphics fallback capturer.
// Returns 0 on success, error code on failure.
int initCaptureCG(int displayIndex) {
    uint32_t maxDisplays = 16;
    CGDirectDisplayID displays[16];
    uint32_t displayCount = 0;

    CGError err = CGGetActiveDisplayList(maxDisplays, displays, &displayCount);
    if (err != kCGErrorSuccess || displayCount == 0) {
        return 1; // failed to get display list
    }

    uint32_t idx = (uint32_t)displayIndex;
    if (idx >= displayCount) idx = 0;

    g_cgDisplayID = displays[idx];
    g_cgDisplayWidth = (int)CGDisplayPixelsWide(g_cgDisplayID);
    g_cgDisplayHeight = (int)CGDisplayPixelsHigh(g_cgDisplayID);

    return 0;
}

// captureFrameCG captures a screenshot using CGWindowListCreateImage.
// Available since macOS 10.5 — works on all supported macOS versions.
ScreenCaptureResult captureFrameCG(void) {
    ScreenCaptureResult result = {0};

    CGRect bounds = CGDisplayBounds(g_cgDisplayID);
    CGImageRef image = CGWindowListCreateImage_compat(
        bounds,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageDefault
    );

    if (image == NULL) {
        result.error = 3; // permission denied or no display
        return result;
    }

    result.width = (int)CGImageGetWidth(image);
    result.height = (int)CGImageGetHeight(image);
    result.bytesPerRow = result.width * 4;

    size_t dataSize = (size_t)result.bytesPerRow * (size_t)result.height;
    result.data = malloc(dataSize);
    if (result.data == NULL) {
        CGImageRelease(image);
        result.error = 4;
        return result;
    }

    CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
    CGContextRef ctx = CGBitmapContextCreate(
        result.data,
        result.width,
        result.height,
        8,
        result.bytesPerRow,
        colorSpace,
        kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big  // RGBA
    );

    if (ctx == NULL) {
        free(result.data);
        result.data = NULL;
        CGColorSpaceRelease(colorSpace);
        CGImageRelease(image);
        result.error = 5;
        return result;
    }

    CGContextDrawImage(ctx, CGRectMake(0, 0, result.width, result.height), image);

    CGContextRelease(ctx);
    CGColorSpaceRelease(colorSpace);
    CGImageRelease(image);

    return result;
}

// releaseCaptureCG frees CoreGraphics fallback state
void releaseCaptureCG(void) {
    g_cgDisplayID = CGMainDisplayID();
    g_cgDisplayWidth = 0;
    g_cgDisplayHeight = 0;
}

// freeCaptureCG frees the capture result data
void freeCaptureCG(void* data) {
    if (data != NULL) {
        free(data);
    }
}

*/
import "C"

import (
	"fmt"
	"image"
	"log/slog"
	"sync"
)

// darwinCGCapturer implements ScreenCapturer for macOS 12-13 using
// CGWindowListCreateImage (CoreGraphics). This API has been available
// since macOS 10.5 and works without ScreenCaptureKit.
type darwinCGCapturer struct {
	config          CaptureConfig
	mu              sync.Mutex
	initialized     bool
	holdsGlobalLock bool
}

// newCGCapturer creates a CoreGraphics-based capturer (macOS 12-13 fallback).
func newCGCapturer(config CaptureConfig) (ScreenCapturer, error) {
	slog.Warn("using CoreGraphics fallback for screen capture (macOS 12-13); ScreenCaptureKit unavailable — consider upgrading to macOS 14+",
		"darwinVersion", macOSMajorVersion, "displayIndex", config.DisplayIndex)
	darwinCaptureMu.Lock()
	errCode := int(C.initCaptureCG(C.int(config.DisplayIndex)))
	if errCode != 0 {
		darwinCaptureMu.Unlock()
		return nil, translateDarwinError(errCode)
	}
	return &darwinCGCapturer{config: config, initialized: true, holdsGlobalLock: true}, nil
}

// Capture captures the entire screen using CGWindowListCreateImage.
func (c *darwinCGCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	result := C.captureFrameCG()

	if result.error != 0 {
		return nil, translateDarwinError(int(result.error))
	}

	if result.data == nil {
		return nil, fmt.Errorf("no frame captured")
	}

	defer C.freeCaptureCG(result.data)

	return createImageFromCGResult(result)
}

// createImageFromCGResult creates a Go image from a CG-preamble ScreenCaptureResult.
func createImageFromCGResult(result C.ScreenCaptureResult) (*image.RGBA, error) {
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

// CaptureRegion captures a specific region of the screen
func (c *darwinCGCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	return captureRegionFromFull(c, x, y, width, height)
}

// GetScreenBounds returns the screen dimensions
func (c *darwinCGCapturer) GetScreenBounds() (width, height int, err error) {
	return getScreenBoundsC(c.config.DisplayIndex)
}

// Close releases resources
func (c *darwinCGCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.initialized {
		C.releaseCaptureCG()
		c.initialized = false
	}
	if c.holdsGlobalLock {
		c.holdsGlobalLock = false
		darwinCaptureMu.Unlock()
	}
	return nil
}

var _ ScreenCapturer = (*darwinCGCapturer)(nil)
