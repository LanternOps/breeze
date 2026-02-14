//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework AppKit -framework Foundation

#include <AppKit/AppKit.h>
#include <stdlib.h>

// getWallpaperPath returns the current wallpaper file URL as a C string.
// Caller must free() the result.
const char* getWallpaperPath() {
    @autoreleasepool {
        NSScreen *screen = [NSScreen mainScreen];
        if (screen == nil) return NULL;

        NSURL *url = [[NSWorkspace sharedWorkspace] desktopImageURLForScreen:screen];
        if (url == nil) return NULL;

        const char *path = [[url path] UTF8String];
        if (path == NULL) return NULL;
        return strdup(path);
    }
}

// setWallpaperSolidColor sets the desktop to a solid black color by removing
// the wallpaper image and setting the fill color to black.
int setWallpaperSolidColor() {
    @autoreleasepool {
        NSScreen *screen = [NSScreen mainScreen];
        if (screen == nil) return -1;

        // Use a 1x1 black pixel image created in-memory so we don't need
        // a temporary file. The fill color key ensures the entire desktop is
        // the solid color even if the image doesn't tile perfectly.
        NSImage *blackImg = [[NSImage alloc] initWithSize:NSMakeSize(1, 1)];
        [blackImg lockFocus];
        [[NSColor blackColor] set];
        NSRectFill(NSMakeRect(0, 0, 1, 1));
        [blackImg unlockFocus];

        // Write to a temp file because setDesktopImageURL requires a file URL.
        NSString *tmpPath = [NSTemporaryDirectory() stringByAppendingPathComponent:@"breeze_black_wallpaper.png"];
        NSBitmapImageRep *rep = [[NSBitmapImageRep alloc]
            initWithBitmapDataPlanes:NULL
            pixelsWide:1
            pixelsHigh:1
            bitsPerSample:8
            samplesPerPixel:4
            hasAlpha:YES
            isPlanar:NO
            colorSpaceName:NSDeviceRGBColorSpace
            bytesPerRow:4
            bitsPerPixel:32];
        [rep setColor:[NSColor blackColor] atX:0 y:0];

        NSData *pngData = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        [pngData writeToFile:tmpPath atomically:YES];

        NSURL *fileURL = [NSURL fileURLWithPath:tmpPath];
        NSDictionary *options = @{
            NSWorkspaceDesktopImageFillColorKey: [NSColor blackColor],
            NSWorkspaceDesktopImageScalingKey: @(NSImageScaleNone),
        };

        NSError *error = nil;
        BOOL ok = [[NSWorkspace sharedWorkspace] setDesktopImageURL:fileURL
                                                          forScreen:screen
                                                            options:options
                                                              error:&error];
        return ok ? 0 : -1;
    }
}

// restoreWallpaper sets the desktop image back to the given path.
int restoreWallpaper(const char* path) {
    @autoreleasepool {
        NSScreen *screen = [NSScreen mainScreen];
        if (screen == nil) return -1;

        NSString *nsPath = [NSString stringWithUTF8String:path];
        NSURL *fileURL = [NSURL fileURLWithPath:nsPath];

        NSError *error = nil;
        BOOL ok = [[NSWorkspace sharedWorkspace] setDesktopImageURL:fileURL
                                                          forScreen:screen
                                                            options:@{}
                                                              error:&error];
        return ok ? 0 : -1;
    }
}
*/
import "C"

import (
	"fmt"
	"unsafe"
)

type darwinWallpaperBackend struct{}

func newWallpaperBackend() wallpaperBackend {
	return &darwinWallpaperBackend{}
}

func (b *darwinWallpaperBackend) GetCurrent() (*WallpaperState, error) {
	cPath := C.getWallpaperPath()
	if cPath == nil {
		return &WallpaperState{}, nil
	}
	defer C.free(unsafe.Pointer(cPath))
	return &WallpaperState{
		WallpaperPath: C.GoString(cPath),
	}, nil
}

func (b *darwinWallpaperBackend) SetSolidBlack() error {
	if ret := C.setWallpaperSolidColor(); ret != 0 {
		return fmt.Errorf("failed to set solid black wallpaper")
	}
	return nil
}

func (b *darwinWallpaperBackend) Restore(state *WallpaperState) error {
	if state.WallpaperPath == "" {
		return nil
	}
	cPath := C.CString(state.WallpaperPath)
	defer C.free(unsafe.Pointer(cPath))
	if ret := C.restoreWallpaper(cPath); ret != 0 {
		return fmt.Errorf("failed to restore wallpaper to %s", state.WallpaperPath)
	}
	return nil
}
