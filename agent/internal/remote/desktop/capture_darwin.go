//go:build darwin

package desktop

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework CoreGraphics -framework CoreFoundation -framework AppKit -framework ScreenCaptureKit -framework CoreMedia -framework CoreVideo

#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>
#include <AppKit/AppKit.h>
#include <ScreenCaptureKit/ScreenCaptureKit.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <stdlib.h>
#include <dispatch/dispatch.h>

// ScreenCaptureResult holds the capture result
typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
} ScreenCaptureResult;

// Semaphore for synchronous capture
static dispatch_semaphore_t g_semaphore = NULL;
static ScreenCaptureResult g_result = {0};
static int g_displayIndex = 0;

// StreamOutput delegate for receiving frames
@interface StreamOutput : NSObject <SCStreamOutput>
@property (nonatomic, assign) BOOL frameReceived;
@end

@implementation StreamOutput

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeScreen || self.frameReceived) {
        return;
    }

    CVImageBufferRef imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (imageBuffer == NULL) {
        g_result.error = 5;
        self.frameReceived = YES;
        dispatch_semaphore_signal(g_semaphore);
        return;
    }

    CVPixelBufferLockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);

    g_result.width = (int)CVPixelBufferGetWidth(imageBuffer);
    g_result.height = (int)CVPixelBufferGetHeight(imageBuffer);
    g_result.bytesPerRow = g_result.width * 4;

    size_t srcBytesPerRow = CVPixelBufferGetBytesPerRow(imageBuffer);
    void* srcData = CVPixelBufferGetBaseAddress(imageBuffer);

    size_t dataSize = g_result.bytesPerRow * g_result.height;
    g_result.data = malloc(dataSize);

    if (g_result.data == NULL) {
        g_result.error = 4;
        CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
        self.frameReceived = YES;
        dispatch_semaphore_signal(g_semaphore);
        return;
    }

    // Copy and convert BGRA to RGBA
    unsigned char* src = (unsigned char*)srcData;
    unsigned char* dst = (unsigned char*)g_result.data;

    for (int y = 0; y < g_result.height; y++) {
        for (int x = 0; x < g_result.width; x++) {
            int srcIdx = y * srcBytesPerRow + x * 4;
            int dstIdx = y * g_result.bytesPerRow + x * 4;
            dst[dstIdx + 0] = src[srcIdx + 2]; // R
            dst[dstIdx + 1] = src[srcIdx + 1]; // G
            dst[dstIdx + 2] = src[srcIdx + 0]; // B
            dst[dstIdx + 3] = src[srcIdx + 3]; // A
        }
    }

    CVPixelBufferUnlockBaseAddress(imageBuffer, kCVPixelBufferLock_ReadOnly);
    self.frameReceived = YES;
    dispatch_semaphore_signal(g_semaphore);
}

@end

static StreamOutput* g_streamOutput = nil;

// captureScreen captures the main display using ScreenCaptureKit
ScreenCaptureResult captureScreen(int displayIndex) {
    memset(&g_result, 0, sizeof(g_result));
    g_displayIndex = displayIndex;

    if (g_semaphore == NULL) {
        g_semaphore = dispatch_semaphore_create(0);
    }

    __block BOOL setupComplete = NO;
    __block int setupError = 0;

    [SCShareableContent getShareableContentWithCompletionHandler:^(SCShareableContent * _Nullable content, NSError * _Nullable error) {
        if (error != nil || content == nil) {
            setupError = 1;
            dispatch_semaphore_signal(g_semaphore);
            return;
        }

        NSArray<SCDisplay *>* displays = content.displays;
        if (displays.count == 0) {
            setupError = 2;
            dispatch_semaphore_signal(g_semaphore);
            return;
        }

        NSUInteger idx = (NSUInteger)displayIndex;
        if (idx >= displays.count) {
            idx = 0;
        }

        SCDisplay* display = displays[idx];

        // Create content filter for just the display
        SCContentFilter* filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];

        // Configure stream
        SCStreamConfiguration* config = [[SCStreamConfiguration alloc] init];
        config.width = display.width * 2;  // Retina scale
        config.height = display.height * 2;
        config.minimumFrameInterval = CMTimeMake(1, 60);
        config.pixelFormat = kCVPixelFormatType_32BGRA;
        config.showsCursor = YES;

        // Create stream
        SCStream* stream = [[SCStream alloc] initWithFilter:filter configuration:config delegate:nil];

        // Add output handler
        if (g_streamOutput == nil) {
            g_streamOutput = [[StreamOutput alloc] init];
        }
        g_streamOutput.frameReceived = NO;

        NSError* addError = nil;
        [stream addStreamOutput:g_streamOutput type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_get_main_queue() error:&addError];

        if (addError != nil) {
            setupError = 3;
            dispatch_semaphore_signal(g_semaphore);
            return;
        }

        // Start capturing
        [stream startCaptureWithCompletionHandler:^(NSError * _Nullable startError) {
            if (startError != nil) {
                setupError = 3;
                dispatch_semaphore_signal(g_semaphore);
                return;
            }

            setupComplete = YES;

            // Wait for frame then stop
            dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                [stream stopCaptureWithCompletionHandler:^(NSError * _Nullable stopError) {
                    // Capture complete
                }];
            });
        }];
    }];

    // Wait for result with timeout
    dispatch_semaphore_wait(g_semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(5.0 * NSEC_PER_SEC)));

    if (setupError != 0) {
        g_result.error = setupError;
    }

    return g_result;
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
	// Capture full screen then crop
	fullImg, err := c.Capture()
	if err != nil {
		return nil, err
	}

	// Create cropped image
	bounds := image.Rect(x, y, x+width, y+height)
	if !bounds.In(fullImg.Bounds()) {
		// Adjust to fit
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

	// Create the image
	img := image.NewRGBA(image.Rect(0, 0, width, height))

	// Copy data from C memory to Go image
	dataSize := bytesPerRow * height
	cData := C.GoBytes(result.data, C.int(dataSize))

	// The data is in RGBA format, handle stride differences
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
		return fmt.Errorf("failed to get shareable content")
	case 2:
		return ErrDisplayNotFound
	case 3:
		return ErrPermissionDenied
	case 4:
		return fmt.Errorf("memory allocation failed")
	case 5:
		return fmt.Errorf("failed to get image buffer")
	default:
		return fmt.Errorf("unknown error: %d", code)
	}
}

// Ensure darwinCapturer implements ScreenCapturer
var _ ScreenCapturer = (*darwinCapturer)(nil)
