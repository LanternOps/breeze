//go:build linux

package desktop

/*
#cgo CFLAGS: -I/usr/include
#cgo LDFLAGS: -lX11 -lXext

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <X11/extensions/XShm.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// ScreenCaptureResult holds the capture result
typedef struct {
    void* data;
    int width;
    int height;
    int bytesPerRow;
    int error;
} ScreenCaptureResult;

// CaptureContext holds X11 context for capturing
typedef struct {
    Display* display;
    Window root;
    int screen;
    int width;
    int height;
    int useShm;
    XShmSegmentInfo shmInfo;
    XImage* shmImage;
} CaptureContext;

static CaptureContext g_ctx = {0};

// initX11 initializes X11 connection
int initX11(int displayIndex) {
    if (g_ctx.display != NULL) {
        return 0; // Already initialized
    }

    g_ctx.display = XOpenDisplay(NULL);
    if (g_ctx.display == NULL) {
        return 1; // Failed to open display
    }

    g_ctx.screen = displayIndex;
    if (g_ctx.screen >= ScreenCount(g_ctx.display)) {
        g_ctx.screen = DefaultScreen(g_ctx.display);
    }

    g_ctx.root = RootWindow(g_ctx.display, g_ctx.screen);
    g_ctx.width = DisplayWidth(g_ctx.display, g_ctx.screen);
    g_ctx.height = DisplayHeight(g_ctx.display, g_ctx.screen);

    // Check for SHM extension
    int major, minor;
    Bool pixmaps;
    if (XShmQueryVersion(g_ctx.display, &major, &minor, &pixmaps)) {
        g_ctx.useShm = 1;

        // Create shared memory image
        g_ctx.shmImage = XShmCreateImage(
            g_ctx.display,
            DefaultVisual(g_ctx.display, g_ctx.screen),
            DefaultDepth(g_ctx.display, g_ctx.screen),
            ZPixmap,
            NULL,
            &g_ctx.shmInfo,
            g_ctx.width,
            g_ctx.height
        );

        if (g_ctx.shmImage != NULL) {
            g_ctx.shmInfo.shmid = shmget(
                IPC_PRIVATE,
                g_ctx.shmImage->bytes_per_line * g_ctx.shmImage->height,
                IPC_CREAT | 0777
            );

            if (g_ctx.shmInfo.shmid >= 0) {
                g_ctx.shmInfo.shmaddr = g_ctx.shmImage->data = shmat(g_ctx.shmInfo.shmid, 0, 0);
                g_ctx.shmInfo.readOnly = False;

                if (XShmAttach(g_ctx.display, &g_ctx.shmInfo)) {
                    return 0; // SHM setup complete
                }
            }

            // SHM setup failed, fall back to regular capture
            XDestroyImage(g_ctx.shmImage);
            g_ctx.shmImage = NULL;
        }
        g_ctx.useShm = 0;
    }

    return 0;
}

// cleanupX11 releases X11 resources
void cleanupX11() {
    if (g_ctx.shmImage != NULL) {
        XShmDetach(g_ctx.display, &g_ctx.shmInfo);
        shmdt(g_ctx.shmInfo.shmaddr);
        shmctl(g_ctx.shmInfo.shmid, IPC_RMID, 0);
        XDestroyImage(g_ctx.shmImage);
        g_ctx.shmImage = NULL;
    }

    if (g_ctx.display != NULL) {
        XCloseDisplay(g_ctx.display);
        g_ctx.display = NULL;
    }

    memset(&g_ctx, 0, sizeof(g_ctx));
}

// captureScreen captures the screen using X11
ScreenCaptureResult captureScreen(int displayIndex) {
    ScreenCaptureResult result = {0};

    int initResult = initX11(displayIndex);
    if (initResult != 0) {
        result.error = initResult;
        return result;
    }

    XImage* image = NULL;

    if (g_ctx.useShm && g_ctx.shmImage != NULL) {
        // Use SHM for faster capture
        if (!XShmGetImage(g_ctx.display, g_ctx.root, g_ctx.shmImage, 0, 0, AllPlanes)) {
            result.error = 2;
            return result;
        }
        image = g_ctx.shmImage;
    } else {
        // Fall back to regular XGetImage
        image = XGetImage(
            g_ctx.display,
            g_ctx.root,
            0, 0,
            g_ctx.width,
            g_ctx.height,
            AllPlanes,
            ZPixmap
        );

        if (image == NULL) {
            result.error = 3;
            return result;
        }
    }

    result.width = image->width;
    result.height = image->height;
    result.bytesPerRow = result.width * 4;

    // Allocate RGBA buffer
    size_t dataSize = result.bytesPerRow * result.height;
    result.data = malloc(dataSize);
    if (result.data == NULL) {
        if (!g_ctx.useShm) {
            XDestroyImage(image);
        }
        result.error = 4;
        return result;
    }

    // Convert to RGBA
    unsigned char* dst = (unsigned char*)result.data;
    int depth = image->bits_per_pixel;

    for (int y = 0; y < result.height; y++) {
        for (int x = 0; x < result.width; x++) {
            unsigned long pixel = XGetPixel(image, x, y);
            int idx = y * result.bytesPerRow + x * 4;

            if (depth == 32 || depth == 24) {
                dst[idx + 0] = (pixel >> 16) & 0xFF; // R
                dst[idx + 1] = (pixel >> 8) & 0xFF;  // G
                dst[idx + 2] = pixel & 0xFF;         // B
                dst[idx + 3] = 255;                   // A
            } else if (depth == 16) {
                // RGB565
                dst[idx + 0] = ((pixel >> 11) & 0x1F) * 255 / 31;
                dst[idx + 1] = ((pixel >> 5) & 0x3F) * 255 / 63;
                dst[idx + 2] = (pixel & 0x1F) * 255 / 31;
                dst[idx + 3] = 255;
            }
        }
    }

    // Cleanup non-SHM image
    if (!g_ctx.useShm) {
        XDestroyImage(image);
    }

    return result;
}

// captureRegion captures a region of the screen
ScreenCaptureResult captureRegion(int displayIndex, int x, int y, int width, int height) {
    ScreenCaptureResult result = {0};

    int initResult = initX11(displayIndex);
    if (initResult != 0) {
        result.error = initResult;
        return result;
    }

    // Validate bounds
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    if (x + width > g_ctx.width) width = g_ctx.width - x;
    if (y + height > g_ctx.height) height = g_ctx.height - y;

    // Use regular XGetImage for region capture
    XImage* image = XGetImage(
        g_ctx.display,
        g_ctx.root,
        x, y,
        width, height,
        AllPlanes,
        ZPixmap
    );

    if (image == NULL) {
        result.error = 3;
        return result;
    }

    result.width = image->width;
    result.height = image->height;
    result.bytesPerRow = result.width * 4;

    size_t dataSize = result.bytesPerRow * result.height;
    result.data = malloc(dataSize);
    if (result.data == NULL) {
        XDestroyImage(image);
        result.error = 4;
        return result;
    }

    unsigned char* dst = (unsigned char*)result.data;
    int depth = image->bits_per_pixel;

    for (int iy = 0; iy < result.height; iy++) {
        for (int ix = 0; ix < result.width; ix++) {
            unsigned long pixel = XGetPixel(image, ix, iy);
            int idx = iy * result.bytesPerRow + ix * 4;

            if (depth == 32 || depth == 24) {
                dst[idx + 0] = (pixel >> 16) & 0xFF;
                dst[idx + 1] = (pixel >> 8) & 0xFF;
                dst[idx + 2] = pixel & 0xFF;
                dst[idx + 3] = 255;
            } else if (depth == 16) {
                dst[idx + 0] = ((pixel >> 11) & 0x1F) * 255 / 31;
                dst[idx + 1] = ((pixel >> 5) & 0x3F) * 255 / 63;
                dst[idx + 2] = (pixel & 0x1F) * 255 / 31;
                dst[idx + 3] = 255;
            }
        }
    }

    XDestroyImage(image);
    return result;
}

// getScreenBounds returns screen dimensions
void getScreenBoundsL(int displayIndex, int* width, int* height, int* error) {
    *error = initX11(displayIndex);
    if (*error == 0) {
        *width = g_ctx.width;
        *height = g_ctx.height;
    }
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

// linuxCapturer implements ScreenCapturer for Linux using X11
type linuxCapturer struct {
	config CaptureConfig
	mu     sync.Mutex
}

// newPlatformCapturer creates a new Linux screen capturer
func newPlatformCapturer(config CaptureConfig) (ScreenCapturer, error) {
	return &linuxCapturer{config: config}, nil
}

// Capture captures the entire screen
func (c *linuxCapturer) Capture() (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	result := C.captureScreen(C.int(c.config.DisplayIndex))

	if result.error != 0 {
		return nil, c.translateError(int(result.error))
	}

	defer C.freeCapture(result.data)

	return c.createImage(result)
}

// CaptureRegion captures a specific region of the screen
func (c *linuxCapturer) CaptureRegion(x, y, width, height int) (*image.RGBA, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	result := C.captureRegion(
		C.int(c.config.DisplayIndex),
		C.int(x),
		C.int(y),
		C.int(width),
		C.int(height),
	)

	if result.error != 0 {
		return nil, c.translateError(int(result.error))
	}

	defer C.freeCapture(result.data)

	return c.createImage(result)
}

// GetScreenBounds returns the screen dimensions
func (c *linuxCapturer) GetScreenBounds() (width, height int, err error) {
	var cWidth, cHeight, cError C.int

	C.getScreenBoundsL(C.int(c.config.DisplayIndex), &cWidth, &cHeight, &cError)

	if cError != 0 {
		return 0, 0, c.translateError(int(cError))
	}

	return int(cWidth), int(cHeight), nil
}

// Close releases resources
func (c *linuxCapturer) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	C.cleanupX11()
	return nil
}

// createImage creates a Go image from the capture result
func (c *linuxCapturer) createImage(result C.ScreenCaptureResult) (*image.RGBA, error) {
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
func (c *linuxCapturer) translateError(code int) error {
	switch code {
	case 1:
		return fmt.Errorf("failed to open X11 display (is DISPLAY set?)")
	case 2:
		return fmt.Errorf("XShmGetImage failed")
	case 3:
		return fmt.Errorf("XGetImage failed")
	case 4:
		return fmt.Errorf("memory allocation failed")
	default:
		return fmt.Errorf("unknown error: %d", code)
	}
}

var _ ScreenCapturer = (*linuxCapturer)(nil)
