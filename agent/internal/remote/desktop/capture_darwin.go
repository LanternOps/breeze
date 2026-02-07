//go:build darwin

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework AppKit -framework ScreenCaptureKit

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <AppKit/AppKit.h>
#include <ScreenCaptureKit/ScreenCaptureKit.h>
#include <stdlib.h>

// ScreenCaptureResult holds the capture result
typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
} ScreenCaptureResult;

// captureScreen captures using SCScreenshotManager (macOS 14+, synchronous via semaphore)
ScreenCaptureResult captureScreen(int displayIndex) {
    __block ScreenCaptureResult result = {0};
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    __block SCDisplay* targetDisplay = nil;

    // Step 1: Get shareable content (display list)
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                             onScreenWindowsOnly:YES
                                             completionHandler:^(SCShareableContent* _Nullable content, NSError* _Nullable error) {
        if (error != nil || content == nil || content.displays.count == 0) {
            result.error = 2;
            dispatch_semaphore_signal(sem);
            return;
        }
        NSUInteger idx = (NSUInteger)displayIndex;
        if (idx >= content.displays.count) idx = 0;
        targetDisplay = content.displays[idx];
        dispatch_semaphore_signal(sem);
    }];

    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    if (result.error != 0 || targetDisplay == nil) return result;

    // Step 2: Capture a single screenshot
    SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:targetDisplay excludingWindows:@[]];
    SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
    config.width = targetDisplay.width;
    config.height = targetDisplay.height;
    config.showsCursor = YES;

    __block CGImageRef capturedImage = NULL;

    [SCScreenshotManager captureImageWithFilter:filter
                                  configuration:config
                              completionHandler:^(CGImageRef _Nullable image, NSError* _Nullable error) {
        if (error != nil || image == NULL) {
            result.error = 3; // Permission denied or capture failed
        } else {
            capturedImage = CGImageRetain(image);
        }
        dispatch_semaphore_signal(sem);
    }];

    dispatch_semaphore_wait(sem, DISPATCH_TIME_FOREVER);
    if (result.error != 0 || capturedImage == NULL) return result;

    // Step 3: Convert CGImage to RGBA pixel data
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
	"sync"
)

// darwinCapturer implements ScreenCapturer for macOS using ScreenCaptureKit
type darwinCapturer struct {
	config CaptureConfig
	mu     sync.Mutex
}

// newPlatformCapturer creates a new macOS screen capturer
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return &darwinCapturer{config: config}, nil
}

// Capture captures the entire screen
func (c *darwinCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	result := C.captureScreen(C.int(c.config.DisplayIndex))

	if result.error != 0 {
		return nil, c.translateError(int(result.error))
	}

	if result.data == nil {
		return nil, fmt.Errorf("no frame captured")
	}

	defer C.freeCapture(result.data)

	return c.createImage(result)
}

// CaptureRegion captures a specific region of the screen
func (c *darwinCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
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

// GetScreenBounds returns the screen dimensions
func (c *darwinCapturer) GetScreenBounds() (width, height int, err error) {
	var cWidth, cHeight, cError C.int

	C.getScreenBounds(C.int(c.config.DisplayIndex), &cWidth, &cHeight, &cError)

	if cError != 0 {
		return 0, 0, c.translateError(int(cError))
	}

	return int(cWidth), int(cHeight), nil
}

// Close releases resources
func (c *darwinCapturer) Close() error {
	return nil
}

// createImage creates a Go image from the capture result
func (c *darwinCapturer) createImage(result C.ScreenCaptureResult) (*image.RGBA, error) {
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

// translateError converts C error codes to Go errors
func (c *darwinCapturer) translateError(code int) error {
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
	default:
		return fmt.Errorf("unknown error: %d", code)
	}
}

var _ ScreenCapturer = (*darwinCapturer)(nil)
