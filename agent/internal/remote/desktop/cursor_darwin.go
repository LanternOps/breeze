//go:build darwin && cgo

package desktop

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework CoreGraphics -framework AppKit

#include <CoreGraphics/CoreGraphics.h>
#include <AppKit/AppKit.h>

// getCursorPosition returns the current mouse cursor position in global
// (display) coordinates using a lightweight CoreGraphics event.
static void getCursorPosition(double* outX, double* outY) {
    CGEventRef event = CGEventCreate(NULL);
    if (event == NULL) {
        *outX = 0;
        *outY = 0;
        return;
    }
    CGPoint loc = CGEventGetLocation(event);
    *outX = loc.x;
    *outY = loc.y;
    CFRelease(event);
}

// getCursorShapeIndex compares [NSCursor currentSystemCursor] against the
// known system cursors and returns an index:
//   0 = arrowCursor      (default)
//   1 = IBeamCursor      (text)
//   2 = pointingHandCursor (pointer)
//   3 = crosshairCursor  (crosshair)
//   4 = openHandCursor   (grab)
//   5 = closedHandCursor (grabbing)
//   6 = resizeLeftRightCursor (ew-resize)
//   7 = resizeUpDownCursor (ns-resize)
//   8 = operationNotAllowedCursor (not-allowed)
//  -1 = unknown / nil
static int getCursorShapeIndex(void) {
    NSCursor *cur = [NSCursor currentSystemCursor];
    if (cur == nil) return -1;

    if (cur == [NSCursor arrowCursor])                return 0;
    if (cur == [NSCursor IBeamCursor])                return 1;
    if (cur == [NSCursor pointingHandCursor])         return 2;
    if (cur == [NSCursor crosshairCursor])            return 3;
    if (cur == [NSCursor openHandCursor])             return 4;
    if (cur == [NSCursor closedHandCursor])           return 5;
    if (cur == [NSCursor resizeLeftRightCursor])      return 6;
    if (cur == [NSCursor resizeUpDownCursor])         return 7;
    if (cur == [NSCursor operationNotAllowedCursor])  return 8;

    return -1;
}
*/
import "C"

// cursorShapeCSS maps the index returned by getCursorShapeIndex() to a CSS
// cursor name. Index -1 (unknown) maps to "default".
var cursorShapeCSS = [9]string{
	"default",     // 0: arrowCursor
	"text",        // 1: IBeamCursor
	"pointer",     // 2: pointingHandCursor
	"crosshair",   // 3: crosshairCursor
	"grab",        // 4: openHandCursor
	"grabbing",    // 5: closedHandCursor
	"ew-resize",   // 6: resizeLeftRightCursor
	"ns-resize",   // 7: resizeUpDownCursor
	"not-allowed", // 8: operationNotAllowedCursor
}

// darwinCursorPosition returns the current mouse cursor position in global
// display coordinates. Uses CGEventCreate which does not require Accessibility
// permission (unlike CGEventTap).
func darwinCursorPosition() (x, y int32) {
	var cx, cy C.double
	C.getCursorPosition(&cx, &cy)
	return int32(cx), int32(cy)
}

// darwinCursorShape returns the CSS cursor name for the current system cursor.
func darwinCursorShape() string {
	idx := int(C.getCursorShapeIndex())
	if idx < 0 || idx >= len(cursorShapeCSS) {
		return "default"
	}
	return cursorShapeCSS[idx]
}

// --- CursorProvider + CursorShapeProvider for darwinCapturer (SCK, macOS 14+) ---

// CursorPosition implements CursorProvider for the ScreenCaptureKit capturer.
func (c *darwinCapturer) CursorPosition() (x, y int32, visible bool) {
	x, y = darwinCursorPosition()
	// macOS does not expose a "cursor hidden" flag via CGEvent, so we
	// always report visible. The cursor is hidden only during full-screen
	// games or when the app explicitly calls [NSCursor hide], which is rare
	// in RMM scenarios.
	return x, y, true
}

// CursorShape implements CursorShapeProvider for the ScreenCaptureKit capturer.
// Returns a CSS cursor name matching the current system cursor.
func (c *darwinCapturer) CursorShape() string {
	return darwinCursorShape()
}

// --- CursorProvider + CursorShapeProvider for darwinCGCapturer (CG, macOS 12-13) ---

// CursorPosition implements CursorProvider for the CoreGraphics capturer.
func (c *darwinCGCapturer) CursorPosition() (x, y int32, visible bool) {
	x, y = darwinCursorPosition()
	return x, y, true
}

// CursorShape implements CursorShapeProvider for the CoreGraphics capturer.
func (c *darwinCGCapturer) CursorShape() string {
	return darwinCursorShape()
}

// Compile-time interface assertions.
var _ CursorProvider = (*darwinCapturer)(nil)
var _ CursorShapeProvider = (*darwinCapturer)(nil)
var _ CursorProvider = (*darwinCGCapturer)(nil)
var _ CursorShapeProvider = (*darwinCGCapturer)(nil)
