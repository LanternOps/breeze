//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework AppKit -weak_framework ScreenCaptureKit
// ScreenCaptureKit is weak-linked so the binary loads on macOS 12-13 where SCK
// doesn't exist — dyld sets unresolved SCK symbols to NULL instead of crashing.
// All SCK classes are still resolved at runtime via NSClassFromString/objc_getClass;
// the weak link is a safety net for ObjC metadata references the compiler may emit.
// Requires CGO_LDFLAGS_ALLOW='-weak_framework|ScreenCaptureKit' in the build environment (set in CI).

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <AppKit/AppKit.h>
#include <stdlib.h>
#include <sys/sysctl.h>
#include <objc/runtime.h>
#include <objc/message.h>

// ScreenCaptureResult holds the capture result
typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
} ScreenCaptureResult;

// darwinMajorVersion returns the Darwin kernel major version.
// Darwin 23 = macOS 14 (Sonoma), 22 = macOS 13 (Ventura), 21 = macOS 12 (Monterey).
int darwinMajorVersion(void) {
    char str[64] = {0};
    size_t size = sizeof(str);
    if (sysctlbyname("kern.osrelease", str, &size, NULL, 0) != 0) {
        return 0;
    }
    int major = 0;
    sscanf(str, "%d", &major);
    return major;
}

// ---- ScreenCaptureKit path (macOS 14+) ----
// All SCK classes are resolved at runtime via NSClassFromString to avoid
// hard dyld symbol references on macOS 12-13 where SCK doesn't exist.
// The framework is NOT linked; classes are loaded dynamically.

// Cached ScreenCaptureKit objects (typed as id to avoid compile-time class refs)
static id g_filter = nil;
static id g_config = nil;

// isSCKAvailable checks if ScreenCaptureKit classes can be loaded at runtime.
static int isSCKAvailable(void) {
    return NSClassFromString(@"SCShareableContent") != nil;
}

// initCapture queries the display list once, caches the filter and config
// for the target display. Returns 0 on success, error code on failure.
int initCapture(int displayIndex) {
    g_filter = nil;
    g_config = nil;

    if (!isSCKAvailable()) return 8; // SCK not available on this macOS version

    Class SCShareableContentClass = NSClassFromString(@"SCShareableContent");
    __block id targetDisplay = nil;
    __block int error = 0;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    // [SCShareableContent getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:]
    SEL sel = NSSelectorFromString(@"getShareableContentExcludingDesktopWindows:onScreenWindowsOnly:completionHandler:");
    void (*sendMsg)(id, SEL, BOOL, BOOL, void(^)(id, NSError*)) = (void*)objc_msgSend;
    sendMsg(SCShareableContentClass, sel, NO, YES, ^(id content, NSError* err) {
        if (err != nil || content == nil) {
            error = 2;
            dispatch_semaphore_signal(sem);
            return;
        }
        NSArray *displays = [content valueForKey:@"displays"];
        if (displays.count == 0) {
            error = 2;
            dispatch_semaphore_signal(sem);
            return;
        }
        NSUInteger idx = (NSUInteger)displayIndex;
        if (idx >= displays.count) idx = 0;
        targetDisplay = displays[idx];
        dispatch_semaphore_signal(sem);
    });

    long timedOut = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC));
    if (timedOut != 0) return 7;
    if (error != 0 || targetDisplay == nil) return error != 0 ? error : 2;

    CGFloat scaleFactor = 1.0;
    NSNumber *displayIDNum = [targetDisplay valueForKey:@"displayID"];
    CGDirectDisplayID targetID = [displayIDNum unsignedIntValue];
    for (NSScreen *screen in [NSScreen screens]) {
        NSNumber *screenNum = screen.deviceDescription[@"NSScreenNumber"];
        if (screenNum && [screenNum unsignedIntValue] == targetID) {
            scaleFactor = [screen backingScaleFactor];
            break;
        }
    }

    Class SCContentFilterClass = NSClassFromString(@"SCContentFilter");
    Class SCStreamConfigClass = NSClassFromString(@"SCStreamConfiguration");

    // [[SCContentFilter alloc] initWithDisplay:excludingWindows:]
    #pragma clang diagnostic push
    #pragma clang diagnostic ignored "-Warc-performSelector-leaks"
    g_filter = [[SCContentFilterClass alloc] performSelector:NSSelectorFromString(@"initWithDisplay:excludingWindows:")
                                                  withObject:targetDisplay
                                                  withObject:@[]];
    #pragma clang diagnostic pop
    g_config = [[SCStreamConfigClass alloc] init];

    NSNumber *widthNum = [targetDisplay valueForKey:@"width"];
    NSNumber *heightNum = [targetDisplay valueForKey:@"height"];
    [g_config setValue:@((size_t)([widthNum doubleValue] * scaleFactor)) forKey:@"width"];
    [g_config setValue:@((size_t)([heightNum doubleValue] * scaleFactor)) forKey:@"height"];
    [g_config setValue:@YES forKey:@"showsCursor"];

    return 0;
}

// captureFrame captures a screenshot using the cached filter/config.
ScreenCaptureResult captureFrame(void) {
    __block ScreenCaptureResult result = {0};

    if (g_filter == nil || g_config == nil) {
        result.error = 6;
        return result;
    }

    Class SCScreenshotManagerClass = NSClassFromString(@"SCScreenshotManager");
    if (SCScreenshotManagerClass == nil) {
        result.error = 8;
        return result;
    }

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block CGImageRef capturedImage = NULL;

    // [SCScreenshotManager captureImageWithFilter:configuration:completionHandler:]
    SEL captureSel = NSSelectorFromString(@"captureImageWithFilter:configuration:completionHandler:");
    void (*sendCapture)(id, SEL, id, id, void(^)(CGImageRef, NSError*)) = (void*)objc_msgSend;
    sendCapture(SCScreenshotManagerClass, captureSel, g_filter, g_config, ^(CGImageRef image, NSError* capError) {
        if (capError != nil || image == NULL) {
            result.error = 3;
        } else {
            capturedImage = CGImageRetain(image);
        }
        dispatch_semaphore_signal(sem);
    });

    long captureTimedOut = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 10LL * NSEC_PER_SEC));
    if (captureTimedOut != 0) {
        result.error = 7;
        return result;
    }
    if (result.error != 0 || capturedImage == NULL) return result;

    // Convert CGImage to RGBA pixel data
    result.width = (int)CGImageGetWidth(capturedImage);
    result.height = (int)CGImageGetHeight(capturedImage);
    result.bytesPerRow = result.width * 4;

    size_t dataSize = (size_t)result.bytesPerRow * (size_t)result.height;
    result.data = malloc(dataSize);
    if (result.data == NULL) {
        CGImageRelease(capturedImage);
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
        CGImageRelease(capturedImage);
        result.error = 5;
        return result;
    }

    CGContextDrawImage(ctx, CGRectMake(0, 0, result.width, result.height), capturedImage);

    CGContextRelease(ctx);
    CGColorSpaceRelease(colorSpace);
    CGImageRelease(capturedImage);

    return result;
}

// releaseCapture frees cached ScreenCaptureKit state
void releaseCapture(void) {
    g_filter = nil;
    g_config = nil;
}

// getScreenBounds returns the bounds of the specified display
void getScreenBounds(int displayIndex, int* width, int* height, int* error) {
    *error = 0;

    NSArray<NSScreen *>* screens = [NSScreen screens];
    if (screens.count == 0) {
        *error = 1;
        return;
    }

    NSUInteger idx = (NSUInteger)displayIndex;
    if (idx >= screens.count) {
        idx = 0;
    }

    NSScreen* screen = screens[idx];
    NSRect frame = [screen frame];
    CGFloat scaleFactor = [screen backingScaleFactor];

    *width = (int)(frame.size.width * scaleFactor);
    *height = (int)(frame.size.height * scaleFactor);
}

// freeCapture frees the capture result data
void freeCapture(void* data) {
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

// darwinCaptureMu serializes access to the global C statics (g_filter, g_config).
// Only one darwinCapturer may be active at a time.
var darwinCaptureMu sync.Mutex

// macOSMajorVersion caches the Darwin kernel major version.
// Darwin 23 = macOS 14 (Sonoma), 22 = macOS 13, 21 = macOS 12.
var macOSMajorVersion = int(C.darwinMajorVersion())

// hasSCScreenshotManager returns true if running macOS 14+ (Darwin 23+)
// where SCScreenshotManager is available.
func hasSCScreenshotManager() bool {
	return macOSMajorVersion >= 23
}

// darwinCapturer implements ScreenCapturer for macOS using ScreenCaptureKit (14+).
// The ScreenCaptureKit display list and filter are queried once at init time
// (triggering a single permission dialog) and cached for per-frame capture.
type darwinCapturer struct {
	config          CaptureConfig
	mu              sync.Mutex
	initialized     bool
	holdsGlobalLock bool
}

// newPlatformCapturer creates a new macOS screen capturer.
// On macOS 14+, uses ScreenCaptureKit (SCScreenshotManager).
// On macOS 12-13, falls back to CGWindowListCreateImage.
// Also falls back to CG if SCK init fails at runtime (e.g., classes don't load).
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	if hasSCScreenshotManager() {
		cap, err := newSCKCapturer(config)
		if err != nil {
			slog.Warn("ScreenCaptureKit init failed, falling back to CoreGraphics",
				"error", err.Error(), "darwinVersion", macOSMajorVersion)
			return newCGCapturer(config)
		}
		return cap, nil
	}
	return newCGCapturer(config)
}

// newSCKCapturer creates a ScreenCaptureKit-based capturer (macOS 14+).
func newSCKCapturer(config CaptureConfig) (ScreenCapturer, error) {
	darwinCaptureMu.Lock()
	errCode := int(C.initCapture(C.int(config.DisplayIndex)))
	if errCode != 0 {
		darwinCaptureMu.Unlock()
		return nil, translateDarwinError(errCode)
	}
	return &darwinCapturer{config: config, initialized: true, holdsGlobalLock: true}, nil
}

// ---- ScreenCaptureKit capturer (macOS 14+) ----

// Capture captures the entire screen using the cached filter/config.
func (c *darwinCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	result := C.captureFrame()

	if result.error != 0 {
		return nil, translateDarwinError(int(result.error))
	}

	if result.data == nil {
		return nil, fmt.Errorf("no frame captured")
	}

	defer C.freeCapture(result.data)

	return createImageFromResult(result)
}

// CaptureRegion captures a specific region of the screen
func (c *darwinCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	return captureRegionFromFull(c, x, y, width, height)
}

// GetScreenBounds returns the screen dimensions
func (c *darwinCapturer) GetScreenBounds() (width, height int, err error) {
	return getScreenBoundsC(c.config.DisplayIndex)
}

// Close releases resources
func (c *darwinCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.initialized {
		C.releaseCapture()
		c.initialized = false
	}
	if c.holdsGlobalLock {
		c.holdsGlobalLock = false
		darwinCaptureMu.Unlock()
	}
	return nil
}

// ---- Shared helpers ----

// createImageFromResult creates a Go image from a C ScreenCaptureResult.
func createImageFromResult(result C.ScreenCaptureResult) (*image.RGBA, error) {
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

// captureRegionFromFull captures a region by first capturing the full screen
// and then cropping to the specified rectangle.
func captureRegionFromFull(c ScreenCapturer, x, y, width, height int) (*image.RGBA, error) {
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}

	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		if x+width > fullImg.Bounds().Dx() {
			width = fullImg.Bounds().Dx() - x
		}
		if y+height > fullImg.Bounds().Dy() {
			height = fullImg.Bounds().Dy() - y
		}
	}

	cropped := image.NewRGBA(image.Rect(0, 0, width, height))
	for dy := 0; dy < height; dy++ {
		for dx := 0; dx < width; dx++ {
			cropped.Set(dx, dy, fullImg.At(x+dx, y+dy))
		}
	}

	return cropped, nil
}

// getScreenBoundsC calls the C getScreenBounds function.
func getScreenBoundsC(displayIndex int) (int, int, error) {
	var cWidth, cHeight, cError C.int

	C.getScreenBounds(C.int(displayIndex), &cWidth, &cHeight, &cError)

	if cError != 0 {
		return 0, 0, translateDarwinError(int(cError))
	}

	return int(cWidth), int(cHeight), nil
}

// translateDarwinError converts C error codes to Go errors
func translateDarwinError(code int) error {
	switch code {
	case 1:
		return fmt.Errorf("failed to get display list")
	case 2:
		return ErrDisplayNotFound
	case 3:
		return ErrPermissionDenied
	case 4:
		return fmt.Errorf("memory allocation failed")
	case 5:
		return fmt.Errorf("failed to create bitmap context")
	case 6:
		return fmt.Errorf("capturer not initialized — call initCapture first")
	case 7:
		return fmt.Errorf("ScreenCaptureKit timed out — process may lack Screen Recording permission (check System Settings > Privacy > Screen Recording)")
	case 8:
		return fmt.Errorf("ScreenCaptureKit not available — classes did not load (weak-link resolved to nil)")
	default:
		return fmt.Errorf("unknown error: %d", code)
	}
}

var _ ScreenCapturer = (*darwinCapturer)(nil)
